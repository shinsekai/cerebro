import type { WorkspaceContext } from "./schemas.js";

export function formatContextForPrompt(ctx: WorkspaceContext): string {
  let output = "=== WORKSPACE CONTEXT ===\n";

  // TECH STACK
  output += "TECH STACK:\n";
  output += `Runtime: ${ctx.profile.runtime} | `;
  output += `Language: ${ctx.profile.language} | `;
  output += `Framework: ${ctx.profile.framework} | `;
  output += `Test Runner: ${ctx.profile.testRunner} | `;
  output += `Linter: ${ctx.profile.linter} | `;
  output += `Package Manager: ${ctx.profile.packageManager}\n`;

  // DIRECTORY STRUCTURE
  output += "\nDIRECTORY STRUCTURE:\n";
  output += ctx.directoryTree;
  output += "\n";

  // RELEVANT FILES
  if (ctx.relevantFiles.length > 0) {
    output += "\nRELEVANT FILES:\n";
    for (const file of ctx.relevantFiles) {
      output += `--- ${file.path} ---\n`;
      output += file.content;
      if (file.truncated) {
        output += "\n... (content truncated due to size limit)";
      }
      output += `\n--- END ${file.path} ---\n`;
    }
  }

  // CONVENTIONS
  if (ctx.conventions) {
    output += "\nCONVENTIONS:\n";
    output += ctx.conventions;
    output += "\n";
  }

  output += "=== END WORKSPACE CONTEXT ===\n";
  return output;
}
