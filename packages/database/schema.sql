CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS state_tickets (
  id UUID PRIMARY KEY,
  task TEXT NOT NULL,
  retry_count INT DEFAULT 0,
  status VARCHAR(20) NOT NULL,
  context JSONB,
  error TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_tickets (
  id UUID PRIMARY KEY,
  task_hash TEXT NOT NULL,
  task_summary TEXT NOT NULL,
  solution_code TEXT NOT NULL,
  -- Assuming Claude generic embeddings match 768 or 1536 dims. Using 1536 for modern usage like OpenAI, or 1024.
  -- Vector dims can be altered later
  embedding vector(768),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_root TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_summary TEXT NOT NULL,
  embedding vector(1024),
  indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_root, file_path)
);
