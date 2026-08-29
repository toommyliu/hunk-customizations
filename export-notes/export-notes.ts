import { spawn } from "node:child_process";
import type {
  ExtensionCommandContext,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotNote,
  HunkExtensionAPI,
} from "hunkdiff/extension";

type ClipboardCommand = readonly [executable: string, ...args: string[]];

function clipboardCommands(): readonly ClipboardCommand[] {
  switch (process.platform) {
    case "darwin":
      return [["pbcopy"]];
    case "win32":
      return [
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::In.ReadToEnd() | Set-Clipboard",
        ],
      ];
    default:
      return [
        ["wl-copy"],
        ["xclip", "-selection", "clipboard", "-in"],
        ["xsel", "--clipboard", "--input"],
      ];
  }
}

function runClipboardCommand([executable, ...args]: ClipboardCommand, text: string) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (copied: boolean) => {
      if (settled) return;
      settled = true;
      resolve(copied);
    };

    const child = spawn(executable, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.end(text);
  });
}

async function writeToClipboard(text: string) {
  for (const command of clipboardCommands()) {
    if (await runClipboardCommand(command, text)) return;
  }

  throw new Error("No supported system clipboard command is available");
}

function clearReviewNotes() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "hunk",
      ["session", "comment", "clear", "--repo", process.cwd(), "--all", "--yes", "--json"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Hunk exited with status ${code ?? "unknown"}`));
    });
  });
}

async function clearCapturedNotes(
  hunk: HunkExtensionAPI,
  ctx: ExtensionCommandContext,
  captured: ExtensionReviewSnapshot,
) {
  if (!snapshotPositionMatches(captured, ctx.review.snapshot())) {
    ctx.notify("The review changed; run the command again", "warning");
    return false;
  }

  try {
    await clearReviewNotes();
  } catch (error) {
    hunk.log(`Could not clear review notes: ${error instanceof Error ? error.message : String(error)}`);
    ctx.notify("Could not clear the saved review notes", "error");
    return false;
  }

  return true;
}

function formatRange(side: "old" | "new", range: readonly [number, number]) {
  const [start, end] = range;
  return start === end ? `${side} ${start}` : `${side} ${start}-${end}`;
}

function formatAnchor(note: ExtensionReviewSnapshotNote) {
  const parts: string[] = [];

  if (note.anchor.ownerHunkIndex !== undefined) {
    parts.push(`hunk ${note.anchor.ownerHunkIndex + 1}`);
  }
  if (note.anchor.oldRange) parts.push(formatRange("old", note.anchor.oldRange));
  if (note.anchor.newRange) parts.push(formatRange("new", note.anchor.newRange));
  if (parts.length > 0) return parts.join(", ");

  if (note.anchor.preferred) {
    return `${note.anchor.preferred.side} line ${note.anchor.preferred.line}`;
  }

  return "file-level note";
}

function indentContinuation(value: string) {
  return value.trim().replaceAll(/\r?\n/g, "\n  ");
}

function formatNote(note: ExtensionReviewSnapshotNote) {
  const status = note.resolution === "active" ? "" : ` [${note.resolution}]`;
  const title = note.title ? `${note.title}: ` : "";
  const lines = [`- ${formatAnchor(note)}${status}: ${title}${indentContinuation(note.summary)}`];
  if (note.rationale) lines.push(`  Why: ${indentContinuation(note.rationale)}`);
  return lines.join("\n");
}

function escapeHeading(value: string) {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("`", "\\`");
}

/** Format every saved Hunk note as a prompt that can be pasted somewhere else. */
export function formatReviewNotes(snapshot: ExtensionReviewSnapshot) {
  const filesByKey = new Map(snapshot.files.map((file) => [file.fileKey, file]));
  const notesByFile = new Map<string, ExtensionReviewSnapshotNote[]>();

  for (const note of snapshot.notes) {
    const notes = notesByFile.get(note.fileKey) ?? [];
    notes.push(note);
    notesByFile.set(note.fileKey, notes);
  }

  const orderedFileKeys = [
    ...snapshot.files.map((file) => file.fileKey).filter((fileKey) => notesByFile.has(fileKey)),
    ...Array.from(notesByFile.keys()).filter((fileKey) => !filesByKey.has(fileKey)),
  ];

  const sections = orderedFileKeys.map((fileKey) => {
    const file = filesByKey.get(fileKey);
    const heading = file ? `\`${escapeHeading(file.path)}\`` : `Unknown file \`${escapeHeading(fileKey)}\``;
    const notes = notesByFile.get(fileKey) ?? [];
    return [`## ${heading}`, ...notes.map(formatNote)].join("\n");
  });

  return ["Address these review comments:", "", ...sections, ""].join("\n");
}

/** Report whether asynchronous work still belongs to the snapshot it started from. */
export function snapshotPositionMatches(
  captured: ExtensionReviewSnapshot,
  current: ExtensionReviewSnapshot | null,
) {
  return (
    current !== null &&
    current.generation === captured.generation &&
    current.stateRevision === captured.stateRevision
  );
}

/** Register the command that copies all saved review notes to the system clipboard. */
export default function registerExportNotes(hunk: HunkExtensionAPI) {
  hunk.registerCommand(
    { id: "copy-notes", title: "Copy review notes", key: "ctrl+e" },
    async (ctx) => {
      const captured = ctx.review.snapshot();
      if (!captured) {
        ctx.notify("The current review is unavailable to this command", "warning");
        return;
      }

      if (captured.notes.length === 0) {
        ctx.notify("There are no saved review notes to copy", "warning");
        return;
      }

      const output = formatReviewNotes(captured);
      if (!snapshotPositionMatches(captured, ctx.review.snapshot())) {
        ctx.notify("The review changed while preparing the notes; run the command again", "warning");
        return;
      }

      try {
        await writeToClipboard(output);
      } catch (error) {
        hunk.log(`Could not copy review notes: ${error instanceof Error ? error.message : String(error)}`);
        ctx.notify("Could not write review notes to the system clipboard", "error");
        return;
      }

      const clearAfterCopy = await ctx.dialogs.confirm({
        title: "Clear copied notes?",
        body: `Remove ${captured.notes.length} saved ${captured.notes.length === 1 ? "note" : "notes"} from this review?`,
        confirmLabel: "Clear notes",
        cancelLabel: "Keep notes",
      });
      if (!clearAfterCopy) {
        ctx.notify(
          `Copied ${captured.notes.length} saved ${captured.notes.length === 1 ? "note" : "notes"} to the clipboard`,
        );
        return;
      }

      if (await clearCapturedNotes(hunk, ctx, captured)) {
        ctx.notify(
          `Copied and cleared ${captured.notes.length} saved ${captured.notes.length === 1 ? "note" : "notes"}`,
        );
      }
    },
  );

  hunk.registerCommand(
    { id: "copy-and-clear-notes", title: "Copy and clear review notes", key: "ctrl+x" },
    async (ctx) => {
      const captured = ctx.review.snapshot();
      if (!captured) {
        ctx.notify("The current review is unavailable to this command", "warning");
        return;
      }

      if (captured.notes.length === 0) {
        ctx.notify("There are no saved review notes to copy", "warning");
        return;
      }

      const output = formatReviewNotes(captured);
      try {
        await writeToClipboard(output);
      } catch (error) {
        hunk.log(`Could not copy review notes: ${error instanceof Error ? error.message : String(error)}`);
        ctx.notify("Could not write review notes to the system clipboard", "error");
        return;
      }

      if (await clearCapturedNotes(hunk, ctx, captured)) {
        ctx.notify(
          `Copied and cleared ${captured.notes.length} saved ${captured.notes.length === 1 ? "note" : "notes"}`,
        );
      }
    },
  );
}
