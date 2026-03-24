import color from "picocolors";

/**
 * Render a colored unified diff line
 */
export function renderDiffLine(line: string): string {
  if (line.startsWith("@@")) {
    return color.cyan(line); // Hunk headers
  } else if (line.startsWith("+")) {
    return color.green(line); // Additions
  } else if (line.startsWith("-")) {
    return color.red(line); // Deletions
  } else if (line.startsWith("---") || line.startsWith("+++")) {
    return color.cyan(line); // File headers
  } else {
    return color.gray(line); // Context
  }
}

/**
 * Display file content or diff
 */
export function displayFileContent(file: {
  path: string;
  operation: string;
  content: string;
  diff?: string;
}) {
  console.log(
    color.dim(`  ${file.operation} ${file.content.length} characters`),
  );
  console.log(color.dim("─".repeat(50)));

  if (file.operation === "update" && file.diff) {
    // Display colored unified diff for updates
    const lines = file.diff.split("\n");
    if (lines.length > 20) {
      console.log(lines.slice(0, 20).map(renderDiffLine).join("\n"));
      console.log(color.dim(`... (${lines.length - 20} more lines)`));
    } else {
      console.log(lines.map(renderDiffLine).join("\n"));
    }
  } else {
    // Display full content for creates or when diff is missing
    const lines = file.content.split("\n");
    if (lines.length > 20) {
      console.log(color.gray(lines.slice(0, 20).join("\n")));
      console.log(color.dim(`... (${lines.length - 20} more lines)`));
    } else {
      console.log(color.gray(lines.join("\n")));
    }
  }
  console.log(color.dim(`${"─".repeat(50)}\n`));
}
