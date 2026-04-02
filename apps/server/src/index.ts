import "dotenv/config"; // Load .env before anything else
import http from "http";
import { createApp } from "./app.js";
import { createWsService } from "./services/wsService.js";
// Start BullMQ worker for agent runs
import "./workers/agentRunWorker.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

const app = createApp();
const server = http.createServer(app);

createWsService(server);

server.listen(port, host, () => {
  console.log(`AgentOps server listening on ${host}:${port}`);
});
