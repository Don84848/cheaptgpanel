import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Settings ──────────────────────────────────────────────────────────────
export const settingsTable = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Channel gate
  requiredChannelId: text("required_channel_id"),
  requiredChannelUsername: text("required_channel_username"),
  requiredChannelName: text("required_channel_name"),
  // Global
  welcomeMessage: text("welcome_message").notNull().default("Welcome! Please select a service:"),
  botEnabled: integer("bot_enabled", { mode: "boolean" }).notNull().default(true),
  adminPassword: text("admin_password").notNull().default("admin123"),
  adminIds: text("admin_ids").default(""),
  // OTP service
  otpApiKey: text("otp_api_key"),
  otpEnabled: integer("otp_enabled", { mode: "boolean" }).notNull().default(true),
  otpMarkup: real("otp_markup").notNull().default(10),
  // Gift Cards service
  giftCardApiKey: text("gift_card_api_key"),
  giftCardEnabled: integer("gift_card_enabled", { mode: "boolean" }).notNull().default(true),
  giftCardMarkup: real("gift_card_markup").notNull().default(10),
  // TG Services
  tgServicesApiKey: text("tg_services_api_key"),
  tgServicesEnabled: integer("tg_services_enabled", { mode: "boolean" }).notNull().default(true),
  tgServicesMarkup: real("tg_services_markup").notNull().default(10),
  // legacy compat
  markupPercent: real("markup_percent").notNull().default(10),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ── Users ─────────────────────────────────────────────────────────────────
export const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramId: integer("telegram_id").notNull().unique(),
  username: text("username"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  balance: real("balance").notNull().default(0),
  isBanned: integer("is_banned", { mode: "boolean" }).notNull().default(false),
  joinedAt: text("joined_at").notNull().default(sql`(datetime('now'))`),
  lastActiveAt: text("last_active_at"),
  totalSpent: real("total_spent").notNull().default(0),
  orderCount: integer("order_count").notNull().default(0),
});

// ── Transactions ──────────────────────────────────────────────────────────
export const transactionsTable = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  type: text("type", { enum: ["otp", "giftcard", "tgservice", "deposit"] }).notNull(),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  status: text("status", { enum: ["pending", "completed", "failed", "refunded"] }).notNull().default("pending"),
  externalRef: text("external_ref"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ── Activity Log ──────────────────────────────────────────────────────────
export const activityLogTable = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type", { enum: ["user_joined", "order_placed", "balance_added", "user_banned"] }).notNull(),
  userId: integer("user_id").notNull(),
  userFirstName: text("user_first_name").notNull(),
  description: text("description").notNull(),
  amount: real("amount"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ── Admin Sessions (state machine for text input) ─────────────────────────
export const adminSessionsTable = sqliteTable("admin_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramId: integer("telegram_id").notNull().unique(),
  isAuthenticated: integer("is_authenticated", { mode: "boolean" }).notNull().default(false),
  awaitingInput: text("awaiting_input"),
  inputData: text("input_data"),
  lastActivity: text("last_activity").notNull().default(sql`(datetime('now'))`),
});

// ── DB factory ────────────────────────────────────────────────────────────
export function createDb(url: string, authToken: string) {
  const client = createClient({ url, authToken });
  return drizzle(client, {
    schema: {
      settingsTable,
      usersTable,
      transactionsTable,
      activityLogTable,
      adminSessionsTable,
    },
  });
}

export type Db = ReturnType<typeof createDb>;
