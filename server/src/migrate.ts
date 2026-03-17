import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";
import { initDb, getDb } from "./db";
import { seedBadges } from "./services";

export async function migrate() {
  await initDb();
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  await seedBadges(getDb());
  console.log("Database migrations applied");
}
