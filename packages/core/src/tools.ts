import { z } from "zod";

// --- Zod Schemas for Tool Inputs/Outputs ---

export const ReadFileInputSchema = z.object({
  path: z.string(),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const WriteFileInputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export const ListDirectoryInputSchema = z.object({
  path: z.string(),
  depth: z.number().int().min(1).max(10).optional().default(3),
});

export type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;

export const RunCommandInputSchema = z.object({
  command: z.string(),
});

export type RunCommandInput = z.infer<typeof RunCommandInputSchema>;

export const SearchFilesInputSchema = z.object({
  query: z.string(),
  filePattern: z.string().optional(),
});

export type SearchFilesInput = z.infer<typeof SearchFilesInputSchema>;

export const TaskCompleteInputSchema = z.object({
  summary: z.string(),
});

export type TaskCompleteInput = z.infer<typeof TaskCompleteInputSchema>;

// --- Claude Tool Definitions (Native tool_use format) ---

export type ClaudeToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description: string;
      }
    >;
    required: string[];
  };
};

const readFileDefinition: ClaudeToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file in the workspace. Use to inspect existing code before making changes.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file to read from workspace root",
      },
    },
    required: ["path"],
  },
};

const writeFileDefinition: ClaudeToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file. Creates if new, updates if exists. Writes are staged for human approval, NOT immediately written to disk.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file to write from workspace root",
      },
      content: {
        type: "string",
        description: "Full content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

const listDirectoryDefinition: ClaudeToolDefinition = {
  name: "list_directory",
  description:
    "List files and directories at a path. Use to explore project structure.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative path to the directory to list from workspace root",
      },
      depth: {
        type: "number",
        description: "Maximum depth to traverse (1-10, default: 3)",
      },
    },
    required: ["path"],
  },
};

const runCommandDefinition: ClaudeToolDefinition = {
  name: "run_command",
  description:
    "Execute a shell command in workspace root. Use for tests, linters, type checks. 30-second timeout.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
    },
    required: ["command"],
  },
};

const searchFilesDefinition: ClaudeToolDefinition = {
  name: "search_files",
  description:
    "Search for text across workspace files. Returns matching lines with paths and line numbers.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text or regex pattern to search for",
      },
      filePattern: {
        type: "string",
        description:
          "Optional glob pattern to filter files (e.g., '*.ts', 'src/**/*.js')",
      },
    },
    required: ["query"],
  },
};

const taskCompleteDefinition: ClaudeToolDefinition = {
  name: "task_complete",
  description:
    "Signal task completion. Call when all file changes and verifications are done.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Summary of what was accomplished",
      },
    },
    required: ["summary"],
  },
};

// --- Export All Tools as Array ---

export const CEREBRO_TOOLS: ClaudeToolDefinition[] = [
  readFileDefinition,
  writeFileDefinition,
  listDirectoryDefinition,
  runCommandDefinition,
  searchFilesDefinition,
  taskCompleteDefinition,
];

// --- Tool Call and Result Schemas ---

export const ToolCallSchema = z.object({
  name: z.enum([
    "read_file",
    "write_file",
    "list_directory",
    "run_command",
    "search_files",
    "task_complete",
  ]),
  input: z.record(z.any()),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  tool_use_id: z.string(),
  content: z.string(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
