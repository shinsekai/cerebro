import "dotenv/config";
import {
  getStateTicket,
  saveMemoryTicket,
  saveStateTicket,
  searchSimilarMemory,
} from "@cerebro/database";
import { Hono } from "hono";
import { logger } from "hono/logger";
import {
  handlePostState,
  handleGetState,
  type StateControllerDeps,
} from "./controllers/stateController.js";
import {
  handlePostMemory,
  handlePostMemorySearch,
  type MemoryControllerDeps,
} from "./controllers/memoryController.js";
import {
  handleMeshLoop,
  type MeshControllerDeps,
} from "./controllers/meshController.js";
import { handleMeshReview, type ReviewControllerDeps } from "./controllers/reviewController.js";
import {
  handleMeshApprove,
  type ApprovalControllerDeps,
} from "./controllers/approvalController.js";
import { approvalService } from "./services/approvalService.js";

const app = new Hono();

app.use("*", logger());

// --- Controller Dependencies ---

const stateDeps: StateControllerDeps = {
  saveStateTicket,
  getStateTicket,
};

const memoryDeps: MemoryControllerDeps = {
  saveMemoryTicket,
  searchSimilarMemory,
};

const meshDeps: MeshControllerDeps = {
  saveStateTicket,
};

const reviewDeps: ReviewControllerDeps = {
  saveStateTicket,
};

const meshOptions = {
  approvalService,
  deps: meshDeps,
};

const approvalDeps: ApprovalControllerDeps = {};

// --- Routes ---

app.get("/", (c) => c.text("Cerebro Engine Running"));

// --- State Endpoints ---
app.post("/state", (c) => handlePostState(c, stateDeps));
app.get("/state/:id", (c) => handleGetState(c, stateDeps));

// --- Memory Endpoints ---
app.post("/memory", (c) => handlePostMemory(c, memoryDeps));
app.post("/memory/search", (c) => handlePostMemorySearch(c, memoryDeps));

// --- Mesh Router (Server-Sent Events) ---
app.post("/mesh/loop", (c) => handleMeshLoop(c, meshOptions));

// --- Approval Endpoint ---
app.post("/mesh/approve", (c) => handleMeshApprove(c, approvalDeps));

// --- Review Endpoint ---
app.post("/mesh/review", (c) => handleMeshReview(c, reviewDeps));

export default {
  port: 8080,
  idleTimeout: 255, // 255 seconds max limit in Bun
  fetch: app.fetch,
};
