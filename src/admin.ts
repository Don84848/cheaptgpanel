import { InlineKeyboard } from "grammy";
import { eq, and, count, sum } from "drizzle-orm";
import type { Db } from "./db";
import { settingsTable, usersTable, transactionsTable, adminSessionsTable, activityLogTable } from "./db";

// ── Auth helpers ──────────────────────────────────────────────────────────
export async function getAdminSession(db: Db, telegramId: number) {
  const [session] = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.telegramId, telegramId));
  return session ?? null;
}

export async function isAdminAuthenticated(db: Db, telegramId: number, settings: any): Promise<boolean> {
  // Check if telegramId is in admin IDs list
  const adminIds = (settings?.adminIds ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (adminIds.includes(String(telegramId))) return true;

  const session = await getAdminSession(db, telegramId);
  if (!session?.isAuthenticated) return false;

  // Session expires after 2 hours
  const lastActivity = new Date(session.lastActivity).getTime();
  if (Date.now() - lastActivity > 2 * 60 * 60 * 1000) {
    await db.update(adminSessionsTable).set({ isAuthenticated: false }).where(eq(adminSessionsTable.telegramId, telegramId));
    return false;
  }
  return true;
}

export async function authenticateAdmin(db: Db, telegramId: number) {
  const now = new Date().toISOString();
  const [existing] = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.telegramId, telegramId));
  if (existing) {
    await db.update(adminSessionsTable).set({ isAuthenticated: true, lastActivity: now, awaitingInput: null }).where(eq(adminSessionsTable.telegramId, telegramId));
  } else {
    await db.insert(adminSessionsTable).values({ telegramId, isAuthenticated: true, lastActivity: now });
  }
}

export async function setAdminAwaiting(db: Db, telegramId: number, state: string, data?: string) {
  const now = new Date().toISOString();
  const [existing] = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.telegramId, telegramId));
  if (existing) {
    await db.update(adminSessionsTable).set({ awaitingInput: state, inputData: data ?? null, lastActivity: now }).where(eq(adminSessionsTable.telegramId, telegramId));
  } else {
    await db.insert(adminSessionsTable).values({ telegramId, awaitingInput: state, inputData: data ?? null, lastActivity: now });
  }
}

export async function clearAdminAwaiting(db: Db, telegramId: number) {
  await db.update(adminSessionsTable).set({ awaitingInput: null, inputData: null }).where(eq(adminSessionsTable.telegramId, telegramId));
}

// ── Stats helpers ─────────────────────────────────────────────────────────
export async function getBotStats(db: Db, type: "otp" | "giftcard" | "tgservice" | "all") {
  const completedStatus = "completed";
  let orderQ: any, revenueQ: any;

  if (type === "all") {
    [{ value: orderQ }] = await db.select({ value: count() }).from(transactionsTable).where(eq(transactionsTable.status, completedStatus));
    [{ value: revenueQ }] = await db.select({ value: sum(transactionsTable.amount) }).from(transactionsTable).where(eq(transactionsTable.status, completedStatus));
  } else {
    [{ value: orderQ }] = await db.select({ value: count() }).from(transactionsTable).where(and(eq(transactionsTable.status, completedStatus), eq(transactionsTable.type, type)));
    [{ value: revenueQ }] = await db.select({ value: sum(transactionsTable.amount) }).from(transactionsTable).where(and(eq(transactionsTable.status, completedStatus), eq(transactionsTable.type, type)));
  }

  return { orders: orderQ ?? 0, revenue: Number(revenueQ ?? 0) };
}

export async function getRecentOrders(db: Db, type: "otp" | "giftcard" | "tgservice") {
  return db.select().from(transactionsTable)
    .where(eq(transactionsTable.type, type))
    .orderBy(transactionsTable.id)
    .limit(5);
}

// ── Keyboard builders ─────────────────────────────────────────────────────
export function mainAdminKeyboard() {
  return new InlineKeyboard()
    .text("📱 OTP Bot Admin", "adm:otp:home").row()
    .text("🎁 Gift Cards Admin", "adm:gc:home").row()
    .text("📣 TG Services Admin", "adm:tg:home").row()
    .text("⚙️ Global Settings", "adm:global:home").row()
    .text("❌ Exit Admin", "adm:exit");
}

export function otpAdminKeyboard(settings: any, stats: { orders: number; revenue: number }) {
  const markup = settings?.otpMarkup ?? 10;
  const enabled = settings?.otpEnabled !== false;
  const hasKey = !!settings?.otpApiKey;
  return new InlineKeyboard()
    .text(`📊 Orders: ${stats.orders} | Revenue: $${stats.revenue.toFixed(2)}`, "adm:noop").row()
    .text(`🔑 ${hasKey ? "Update API Key" : "Set API Key ⚠️"}`, "adm:otp:setkey").row()
    .text(`💹 Markup: ${markup}% → Change`, "adm:otp:setmarkup").row()
    .text(`${enabled ? "🟢 OTP: ON" : "🔴 OTP: OFF"} → Toggle`, "adm:otp:toggle").row()
    .text("📋 Recent Orders", "adm:otp:orders").row()
    .text("◀️ Back to Admin Menu", "adm:home");
}

export function gcAdminKeyboard(settings: any, stats: { orders: number; revenue: number }) {
  const markup = settings?.giftCardMarkup ?? 10;
  const enabled = settings?.giftCardEnabled !== false;
  const hasKey = !!settings?.giftCardApiKey;
  return new InlineKeyboard()
    .text(`📊 Orders: ${stats.orders} | Revenue: $${stats.revenue.toFixed(2)}`, "adm:noop").row()
    .text(`🔑 ${hasKey ? "Update API Key" : "Set API Key ⚠️"}`, "adm:gc:setkey").row()
    .text(`💹 Markup: ${markup}% → Change`, "adm:gc:setmarkup").row()
    .text(`${enabled ? "🟢 Gift Cards: ON" : "🔴 Gift Cards: OFF"} → Toggle`, "adm:gc:toggle").row()
    .text("📋 Recent Orders", "adm:gc:orders").row()
    .text("◀️ Back to Admin Menu", "adm:home");
}

export function tgAdminKeyboard(settings: any, stats: { orders: number; revenue: number }) {
  const markup = settings?.tgServicesMarkup ?? 10;
  const enabled = settings?.tgServicesEnabled !== false;
  const hasKey = !!settings?.tgServicesApiKey;
  return new InlineKeyboard()
    .text(`📊 Orders: ${stats.orders} | Revenue: $${stats.revenue.toFixed(2)}`, "adm:noop").row()
    .text(`🔑 ${hasKey ? "Update API Key" : "Set API Key ⚠️"}`, "adm:tg:setkey").row()
    .text(`💹 Markup: ${markup}% → Change`, "adm:tg:setmarkup").row()
    .text(`${enabled ? "🟢 TG Services: ON" : "🔴 TG Services: OFF"} → Toggle`, "adm:tg:toggle").row()
    .text("📋 Recent Orders", "adm:tg:orders").row()
    .text("◀️ Back to Admin Menu", "adm:home");
}

export function globalAdminKeyboard(totalUsers: number, botEnabled: boolean) {
  return new InlineKeyboard()
    .text(`👥 Total Users: ${totalUsers}`, "adm:noop").row()
    .text("📢 Set Required Channel", "adm:global:setchannel").row()
    .text("👋 Set Welcome Message", "adm:global:setwelcome").row()
    .text("📣 Broadcast Message", "adm:global:broadcast").row()
    .text("🔍 Find User by ID / @username", "adm:global:finduser").row()
    .text("💰 Add Balance to User", "adm:global:addbal").row()
    .text("🚫 Ban User", "adm:global:ban").row()
    .text("✅ Unban User", "adm:global:unban").row()
    .text(`${botEnabled ? "🟢 Bot: ON" : "🔴 Bot: OFF"} → Toggle`, "adm:global:togglebot").row()
    .text("🔑 Change Admin Password", "adm:global:setpwd").row()
    .text("👑 Add Admin by Telegram ID", "adm:global:addadmin").row()
    .text("◀️ Back to Admin Menu", "adm:home");
}

export function formatRecentOrders(orders: any[], type: string) {
  if (!orders.length) return `No ${type} orders yet.`;
  return orders
    .map((o) => `• #${o.id} | $${o.amount.toFixed(2)} | ${o.status}\n  ${o.description.slice(0, 40)}`)
    .join("\n");
}
