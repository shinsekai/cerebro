import fs from "node:fs/promises";
import path from "node:path";
import {
  buildDirectoryTree,
  type IndexWorkspaceResult,
  indexWorkspace,
  scanWorkspace,
} from "@cerebro/workspace";
import type { Spinner } from "@clack/prompts";
import { confirm, isCancel, spinner } from "@clack/prompts";
import color from "picocolors";
import { findWorkspaceRoot } from "../lib/workspace.js";

export async function runInit(s: Spinner): Promise<void> {
  s.start("Scanning workspace...");
  const workspaceRoot = await findWorkspaceRoot(process.cwd());
  const profile = await scanWorkspace(workspaceRoot);
  const tree = await buildDirectoryTree(workspaceRoot);

  // Create .cerebro directory
  const cerebroDir = path.join(workspaceRoot, ".cerebro");
  await fs.mkdir(cerebroDir, { recursive: true });

  // Write profile.json
  const profilePath = path.join(cerebroDir, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), "utf-8");

  // Write tree.json
  const treePath = path.join(cerebroDir, "tree.json");
  await fs.writeFile(treePath, JSON.stringify(tree, null, 2), "utf-8");

  // Count files in tree
  const fileCount = tree
    .split("\n")
    .filter((line) => line && !line.endsWith("/")).length;
  const dirCount = tree.split("\n").filter((line) => line.endsWith("/")).length;

  // Stop spinner and show summary
  s.stop(color.green(`✔ Cerebro initialized`));

  console.log(color.dim("─".repeat(50)));
  console.log(
    `  ${color.cyan("Runtime:")} ${profile.runtime} | ${color.cyan("Language:")} ${profile.language} | ${color.cyan("Framework:")} ${profile.framework}`,
  );
  console.log(
    `  ${color.cyan("Test runner:")} ${profile.testRunner} | ${color.cyan("Linter:")} ${profile.linter}`,
  );
  console.log(
    `  ${color.cyan("Database:")} ${profile.database} | ${color.cyan("Monorepo:")} ${profile.monorepo ? "yes" : "no"}`,
  );
  console.log(
    `  ${color.cyan("Indexed")} ${fileCount} files across ${dirCount} directories`,
  );
  console.log(color.dim("─".repeat(50)));

  // Suggest adding to .gitignore
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let gitignoreContent = "";
  try {
    gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist
  }

  if (!gitignoreContent.includes(".cerebro")) {
    console.log(
      color.yellow(
        `\n⚠ Consider adding ${color.cyan(".cerebro")} to ${color.cyan(".gitignore")}:`,
      ),
    );
    console.log(color.dim('  echo ".cerebro" >> .gitignore'));
  }

  // Offer semantic indexing if VOYAGE_API_KEY is set
  if (process.env.VOYAGE_API_KEY) {
    const shouldIndex = await confirm({
      message:
        "Index workspace for semantic search? (improves context quality, ~$0.02)",
      initialValue: false,
    });

    if (shouldIndex && !isCancel(shouldIndex)) {
      const indexSpinner = spinner();
      indexSpinner.start(`Indexing ${fileCount} files...`);

      try {
        const result: IndexWorkspaceResult =
          await indexWorkspace(workspaceRoot);
        indexSpinner.stop(
          color.green(
            `✔ Semantic index created (${result.filesIndexed} files)`,
          ),
        );

        if (result.errors.length > 0) {
          console.log(
            color.dim(
              `\n⚠ ${result.errors.length} files skipped due to errors`,
            ),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Check if it's a database connection error
        if (
          message.includes("ECONNREFUSED") ||
          message.includes("database") ||
          message.includes("connection")
        ) {
          indexSpinner.stop(
            color.yellow(
              "⚠ Database unavailable — skipping semantic index. Run `make db-up` first.",
            ),
          );
        } else {
          indexSpinner.stop(color.yellow(`⚠ Indexing failed: ${message}`));
        }
      }
    }
  }
}
