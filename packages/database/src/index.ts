import postgres from "postgres";

// Ensure the connection config pulls from environment variables
// Expected env variables: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB etc.
const sql = postgres({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.POSTGRES_DB || "cerebro",
  username: process.env.POSTGRES_USER || "cerebro",
  password: process.env.POSTGRES_PASSWORD || "cerebro_password",
  transform: postgres.camel,
});

export async function checkConnection() {
  try {
    const [{ current_database }] = await sql`SELECT current_database()`;
    console.log(`Connected to database: ${current_database}`);
  } catch (error) {
    console.error("Failed to connect to database", error);
    process.exit(1);
  }
}

export { sql };
export * from "./queries.js";
