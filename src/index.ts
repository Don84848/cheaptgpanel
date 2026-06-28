import { Bot, webhookCallback, InlineKeyboard } from "grammy";
import { eq, count } from "drizzle-orm";
import {
  createDb, settingsTable, usersTable, activityLogTable,
  transactionsTable, adminSessionsTable,
} from "./db";
import {
  isAdminAuthenticated, authenticateAdmin, setAdminAwaiting, clearAdminAwaiting,
  getAdminSession, getBotStats, getRecentOrders, formatRecentOrders,
  mainAdminKeyboard, otpAdminKeyboard, gcAdminKeyboard, tgAdminKeyboard, globalAdminKeyboard,
} from "./admin";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  ADMIN_WEBHOOK_SECRET?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
type DbType = ReturnType<typeof createDb>;

async function getSettings(db: DbType) {
  const [s] = await db.select().from(settingsTable).limit(1);
  if (!s) {
    const [created] = await db.insert(settingsTable).values({}).returning();
    return created;
  }
  return s;
}

async function getOrCreateUser(db: DbType, tgUser: { id: number; first_name: string; last_name?: string; username?: string }) {
  let [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, tgUser.id));
  if (!user) {
    const now = new Date().toISOString();
    [user] = await db.insert(usersTable).values({
      telegramId: tgUser.id, firstName: tgUser.first_name,
      lastName: tgUser.last_name ?? null, username: tgUser.username ?? null,
      joinedAt: now, lastActiveAt: now,
    }).returning();
    await db.insert(activityLogTable).values({
      type: "user_joined", userId: user.id, userFirstName: user.firstName,
      description: `@${user.username ?? user.telegramId} joined the bot`, createdAt: now,
    });
  } else {
    await db.update(usersTable).set({ lastActiveAt: new Date().toISOString() }).where(eq(usersTable.id, user.id));
  }
  return user;
}

async function checkChannelMembership(botToken: string, channelId: string, userId: number) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${channelId}&user_id=${userId}`);
    const data = (await res.json()) as any;
    return ["member", "administrator", "creator"].includes(data?.result?.status);
  } catch { return false; }
}

function mainMenuKeyboard(settings: any) {
  const kb = new InlineKeyboard();
  if (settings?.otpEnabled !== false) kb.text("📱 Cheap OTPs Bot", "menu:otp").row();
  if (settings?.giftCardEnabled !== false) kb.text("🎁 Cheap Gift Cards Bot", "menu:giftcards").row();
  if (settings?.tgServicesEnabled !== false) kb.text("📣 Cheap TG Services Bot", "menu:tgservices").row();
  return kb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service sub-menus
// ─────────────────────────────────────────────────────────────────────────────
async function otpCountriesMenu(settings: any) {
  const apiKey = settings?.otpApiKey;
  if (!apiKey) return { text: "⚠️ OTP service is not configured yet. Please try later.", kb: new InlineKeyboard().text("◀️ Back", "menu:main") };
  try {
    const r = await fetch(`https://otpget.com/api/getCountries?key=${apiKey}`);
    const data = (await r.json()) as any[];
    const countries = (Array.isArray(data) ? data : []).slice(0, 12);
    const kb = new InlineKeyboard();
    for (const c of countries) kb.text(`${c.name} — $${c.price}`, `otp:c:${c.id}`).row();
    kb.text("◀️ Back", "menu:main");
    return { text: "🌍 *Cheap OTPs Bot*\nSelect a country:", kb };
  } catch { return { text: "OTP service temporarily unavailable.", kb: new InlineKeyboard().text("◀️ Back", "menu:main") }; }
}

async function gcCategoriesMenu(settings: any) {
  const apiKey = settings?.giftCardApiKey;
  if (!apiKey) return { text: "⚠️ Gift Cards service not configured.", kb: new InlineKeyboard().text("◀️ Back", "menu:main") };
  try {
    const r = await fetch(`https://api.g2bulk.com/api/v1/categories`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const data = (await r.json()) as any;
    const cats = (Array.isArray(data) ? data : data.data ?? []).slice(0, 12);
    const kb = new InlineKeyboard();
    for (const c of cats) kb.text(c.name, `gc:cat:${c.id}`).row();
    kb.text("◀️ Back", "menu:main");
    return { text: "🎁 *Cheap Gift Cards Bot*\nSelect a category:", kb };
  } catch { return { text: "Gift Cards service temporarily unavailable.", kb: new InlineKeyboard().text("◀️ Back", "menu:main") }; }
}

async function tgCategoriesMenu(settings: any) {
  const apiKey = settings?.tgServicesApiKey;
  if (!apiKey) return { text: "⚠️ TG Services not configured.", kb: new InlineKeyboard().text("◀️ Back", "menu:main") };
  try {
    const r = await fetch("https://smmmain.com/api/v2", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: apiKey, action: "services" }),
    });
    const data = (await r.json()) as any[];
    const services: any[] = Array.isArray(data) ? data : [];
    const catMap = new Map<string, string>();
    services.forEach((s: any) => { if (s.category) catMap.set(s.category, s.category); });
    const cats = Array.from(catMap.keys()).slice(0, 12);
    const kb = new InlineKeyboard();
    for (const cat of cats) kb.text(cat, `tg:cat:${encodeURIComponent(cat)}`).row();
    kb.text("◀️ Back", "menu:main");
    return { text: "📣 *Cheap TG Services Bot*\nSelect a category:", kb };
  } catch { return { text: "TG Services temporarily unavailable.", kb: new InlineKeyboard().text("◀️ Back", "menu:main") }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker entry
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") return new Response("Bot is running ✅", { status: 200 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (env.ADMIN_WEBHOOK_SECRET && secret !== env.ADMIN_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

    const db = createDb(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

    // ── /start ──────────────────────────────────────────────────────────────
    bot.command("start", async (ctx) => {
      if (!ctx.from) return;
      const settings = await getSettings(db);
      if (!settings.botEnabled) return ctx.reply("🔴 Bot is currently offline.");

      const user = await getOrCreateUser(db, ctx.from);
      if (user.isBanned) return ctx.reply("🚫 You are banned from this bot.");

      if (settings.requiredChannelId) {
        const ok = await checkChannelMembership(env.TELEGRAM_BOT_TOKEN, settings.requiredChannelId, ctx.from.id);
        if (!ok) {
          const cName = settings.requiredChannelName || settings.requiredChannelUsername || "our channel";
          const kb = new InlineKeyboard();
          if (settings.requiredChannelUsername) kb.url(`👉 Join ${cName}`, `https://t.me/${settings.requiredChannelUsername.replace("@", "")}`).row();
          kb.text("✅ I Joined — Check Again", "check:channel");
          return ctx.reply(`⚠️ To use this bot, please join ${cName} first.`, { reply_markup: kb });
        }
      }

      await ctx.reply(settings.welcomeMessage, { reply_markup: mainMenuKeyboard(settings), parse_mode: "Markdown" });
    });

    // ── /admin ──────────────────────────────────────────────────────────────
    bot.command("admin", async (ctx) => {
      if (!ctx.from) return;
      const settings = await getSettings(db);
      const authed = await isAdminAuthenticated(db, ctx.from.id, settings);
      if (authed) {
        return ctx.reply("🔧 *ADMIN PANEL*\nSelect a section:", { reply_markup: mainAdminKeyboard(), parse_mode: "Markdown" });
      }
      await setAdminAwaiting(db, ctx.from.id, "await_password");
      return ctx.reply("🔐 Enter admin password:");
    });

    // ── /balance ─────────────────────────────────────────────────────────────
    bot.command("balance", async (ctx) => {
      if (!ctx.from) return;
      const user = await getOrCreateUser(db, ctx.from);
      ctx.reply(`💰 Your balance: *$${user.balance.toFixed(2)}*`, { parse_mode: "Markdown" });
    });

    // ── /help ────────────────────────────────────────────────────────────────
    bot.command("help", async (ctx) => {
      ctx.reply("📋 *Commands:*\n/start — Main menu\n/balance — Your balance\n/admin — Admin panel\n/help — This help", { parse_mode: "Markdown" });
    });

    // ── Text messages (state machine for admin input) ────────────────────────
    bot.on("message:text", async (ctx) => {
      if (!ctx.from) return;
      const text = ctx.message.text;
      if (text.startsWith("/")) return; // skip commands

      const session = await getAdminSession(db, ctx.from.id);
      if (!session?.awaitingInput) return; // not waiting for input

      const state = session.awaitingInput;
      const settings = await getSettings(db);
      const now = new Date().toISOString();

      // ── Password check ──────────────────────────────────────────────────
      if (state === "await_password") {
        if (text === settings.adminPassword) {
          await authenticateAdmin(db, ctx.from.id);
          return ctx.reply("✅ *Authenticated!*\n\n🔧 *ADMIN PANEL*\nSelect a section:", { reply_markup: mainAdminKeyboard(), parse_mode: "Markdown" });
        } else {
          await clearAdminAwaiting(db, ctx.from.id);
          return ctx.reply("❌ Wrong password.");
        }
      }

      // Guard: must be authenticated for everything below
      const authed = await isAdminAuthenticated(db, ctx.from.id, settings);
      if (!authed) { await clearAdminAwaiting(db, ctx.from.id); return ctx.reply("Session expired. Use /admin"); }

      // ── Per-state handlers ──────────────────────────────────────────────
      if (state === "await_otp_key") {
        await db.update(settingsTable).set({ otpApiKey: text, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const stats = await getBotStats(db, "otp");
        const s2 = await getSettings(db);
        return ctx.reply("✅ OTP API Key saved!\n\n📱 *OTP Bot Admin*", { reply_markup: otpAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (state === "await_otp_markup") {
        const v = parseFloat(text);
        if (isNaN(v) || v < 0 || v > 500) return ctx.reply("❌ Enter a valid number (0–500):");
        await db.update(settingsTable).set({ otpMarkup: v, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const stats = await getBotStats(db, "otp");
        const s2 = await getSettings(db);
        return ctx.reply(`✅ OTP markup set to ${v}%!\n\n📱 *OTP Bot Admin*`, { reply_markup: otpAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (state === "await_gc_key") {
        await db.update(settingsTable).set({ giftCardApiKey: text, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const stats = await getBotStats(db, "giftcard");
        const s2 = await getSettings(db);
        return ctx.reply("✅ Gift Cards API Key saved!\n\n🎁 *Gift Cards Admin*", { reply_markup: gcAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (state === "await_gc_markup") {
        const v = parseFloat(text);
        if (isNaN(v) || v < 0 || v > 500) return ctx.reply("❌ Enter a valid number (0–500):");
        await db.update(settingsTable).set({ giftCardMarkup: v, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const stats = await getBotStats(db, "giftcard");
        const s2 = await getSettings(db);
        return ctx.reply(`✅ Gift Cards markup set to ${v}%!\n\n🎁 *Gift Cards Admin*`, { reply_markup: gcAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (state === "await_tg_key") {
        await db.update(settingsTable).set({ tgServicesApiKey: text, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const stats = await getBotStats(db, "tgservice");
        const s2 = await getSettings(db);
        return ctx.reply("✅ TG Services API Key saved!\n\n📣 *TG Services Admin*", { reply_markup: tgAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (state === "await_tg_markup") {
        const v = parseFloat(text);
        if (isNaN(v) || v < 0 || v > 500) return ctx.reply("❌ Enter a valid number (0–500):");
        await db.update(settingsTable).set({ tgServicesMarkup: v, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const stats = await getBotStats(db, "tgservice");
        const s2 = await getSettings(db);
        return ctx.reply(`✅ TG markup set to ${v}%!\n\n📣 *TG Services Admin*`, { reply_markup: tgAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (state === "await_channel") {
        // Accepts @username or -100xxxxx format
        const channelId = text.startsWith("@") ? text : text;
        const channelUsername = text.startsWith("@") ? text : null;
        await db.update(settingsTable).set({ requiredChannelId: channelId, requiredChannelUsername: channelUsername, requiredChannelName: channelId, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const [{ total }] = await db.select({ total: count() }).from(usersTable);
        const s2 = await getSettings(db);
        return ctx.reply(`✅ Required channel set to: ${channelId}\n\n⚙️ *Global Settings*`, { reply_markup: globalAdminKeyboard(total, s2.botEnabled), parse_mode: "Markdown" });
      }

      if (state === "await_welcome") {
        await db.update(settingsTable).set({ welcomeMessage: text, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        const [{ total }] = await db.select({ total: count() }).from(usersTable);
        const s2 = await getSettings(db);
        return ctx.reply("✅ Welcome message updated!\n\n⚙️ *Global Settings*", { reply_markup: globalAdminKeyboard(total, s2.botEnabled), parse_mode: "Markdown" });
      }

      if (state === "await_broadcast") {
        await clearAdminAwaiting(db, ctx.from.id);
        const users = await db.select({ telegramId: usersTable.telegramId, isBanned: usersTable.isBanned }).from(usersTable);
        let sent = 0, failed = 0;
        for (const u of users) {
          if (u.isBanned) { failed++; continue; }
          try {
            const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: u.telegramId, text, parse_mode: "Markdown" }),
            });
            if ((await r.json() as any).ok) sent++; else failed++;
          } catch { failed++; }
        }
        return ctx.reply(`📣 Broadcast sent!\n✅ Delivered: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${users.length}`);
      }

      if (state === "await_finduser") {
        await clearAdminAwaiting(db, ctx.from.id);
        const searchId = parseInt(text);
        const [user] = text.startsWith("@")
          ? await db.select().from(usersTable).where(eq(usersTable.username, text.slice(1)))
          : isNaN(searchId)
            ? []
            : await db.select().from(usersTable).where(eq(usersTable.telegramId, searchId));
        if (!user) return ctx.reply("❌ User not found.");
        const kb = new InlineKeyboard()
          .text("💰 Add Balance", `adm:user:addbal:${user.id}`).row()
          .text("🚫 Ban", `adm:user:ban:${user.id}`).text("✅ Unban", `adm:user:unban:${user.id}`).row()
          .text("◀️ Back", "adm:global:home");
        return ctx.reply(
          `👤 *User Info*\nName: ${user.firstName}${user.lastName ? " " + user.lastName : ""}\n@${user.username ?? "none"}\nTG ID: \`${user.telegramId}\`\nBalance: $${user.balance.toFixed(2)}\nOrders: ${user.orderCount}\nBanned: ${user.isBanned ? "Yes 🚫" : "No ✅"}\nJoined: ${user.joinedAt.split("T")[0]}`,
          { reply_markup: kb, parse_mode: "Markdown" }
        );
      }

      if (state === "await_addbal_id") {
        const uid = parseInt(text);
        if (isNaN(uid)) return ctx.reply("❌ Enter a valid Telegram ID:");
        await setAdminAwaiting(db, ctx.from.id, "await_addbal_amount", String(uid));
        return ctx.reply(`💰 Enter amount to add for user ${uid}:`);
      }

      if (state === "await_addbal_amount") {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Enter a valid positive amount:");
        const targetId = parseInt(session.inputData ?? "0");
        const [target] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
        if (!target) { await clearAdminAwaiting(db, ctx.from.id); return ctx.reply("❌ User not found."); }
        await db.update(usersTable).set({ balance: target.balance + amount }).where(eq(usersTable.id, target.id));
        await db.insert(transactionsTable).values({ userId: target.id, type: "deposit", description: `Admin added $${amount}`, amount, status: "completed" });
        await db.insert(activityLogTable).values({ type: "balance_added", userId: target.id, userFirstName: target.firstName, description: `Admin added $${amount}`, amount, createdAt: now });
        await clearAdminAwaiting(db, ctx.from.id);
        return ctx.reply(`✅ Added *$${amount}* to ${target.firstName}'s balance.\nNew balance: *$${(target.balance + amount).toFixed(2)}*`, { parse_mode: "Markdown" });
      }

      if (state === "await_ban_id") {
        const uid = parseInt(text);
        if (isNaN(uid)) return ctx.reply("❌ Enter a valid Telegram ID:");
        const [target] = await db.select().from(usersTable).where(eq(usersTable.telegramId, uid));
        if (!target) { await clearAdminAwaiting(db, ctx.from.id); return ctx.reply("❌ User not found."); }
        await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.id, target.id));
        await db.insert(activityLogTable).values({ type: "user_banned", userId: target.id, userFirstName: target.firstName, description: `User banned by admin`, createdAt: now });
        await clearAdminAwaiting(db, ctx.from.id);
        return ctx.reply(`🚫 User ${target.firstName} (${uid}) has been banned.`);
      }

      if (state === "await_unban_id") {
        const uid = parseInt(text);
        if (isNaN(uid)) return ctx.reply("❌ Enter a valid Telegram ID:");
        const [target] = await db.select().from(usersTable).where(eq(usersTable.telegramId, uid));
        if (!target) { await clearAdminAwaiting(db, ctx.from.id); return ctx.reply("❌ User not found."); }
        await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.id, target.id));
        await clearAdminAwaiting(db, ctx.from.id);
        return ctx.reply(`✅ User ${target.firstName} (${uid}) has been unbanned.`);
      }

      if (state === "await_new_password") {
        await db.update(settingsTable).set({ adminPassword: text, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        return ctx.reply("✅ Admin password updated successfully!");
      }

      if (state === "await_add_admin_id") {
        const newId = text.trim();
        const existing = (settings.adminIds ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
        if (!existing.includes(newId)) existing.push(newId);
        await db.update(settingsTable).set({ adminIds: existing.join(","), updatedAt: now }).where(eq(settingsTable.id, settings.id));
        await clearAdminAwaiting(db, ctx.from.id);
        return ctx.reply(`✅ Telegram ID ${newId} added as admin. They can now use /admin without a password.`);
      }

      if (state?.startsWith("await_addbal_for:")) {
        const userId = parseInt(state.split(":")[1]);
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Enter a valid amount:");
        const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        if (!target) { await clearAdminAwaiting(db, ctx.from.id); return ctx.reply("❌ User not found."); }
        await db.update(usersTable).set({ balance: target.balance + amount }).where(eq(usersTable.id, target.id));
        await db.insert(transactionsTable).values({ userId: target.id, type: "deposit", description: `Admin added $${amount}`, amount, status: "completed" });
        await clearAdminAwaiting(db, ctx.from.id);
        return ctx.reply(`✅ Added *$${amount}* to ${target.firstName}.\nNew balance: *$${(target.balance + amount).toFixed(2)}*`, { parse_mode: "Markdown" });
      }
    });

    // ── Callback queries ─────────────────────────────────────────────────────
    bot.on("callback_query:data", async (ctx) => {
      if (!ctx.from) return;
      const data = ctx.callbackQuery.data;
      const settings = await getSettings(db);
      await db.update(usersTable).set({ lastActiveAt: new Date().toISOString() }).where(eq(usersTable.telegramId, ctx.from.id));

      // No-op button (display only)
      if (data === "adm:noop") return ctx.answerCallbackQuery();

      // ── Channel check ─────────────────────────────────────────────────
      if (data === "check:channel") {
        if (settings.requiredChannelId) {
          const ok = await checkChannelMembership(env.TELEGRAM_BOT_TOKEN, settings.requiredChannelId, ctx.from.id);
          if (!ok) return ctx.answerCallbackQuery("❌ You haven't joined yet!", { show_alert: true });
        }
        await ctx.answerCallbackQuery("✅ Welcome!");
        return ctx.editMessageText(settings.welcomeMessage, { reply_markup: mainMenuKeyboard(settings) });
      }

      // ── Main menu ─────────────────────────────────────────────────────
      if (data === "menu:main") {
        await ctx.answerCallbackQuery();
        return ctx.editMessageText(settings.welcomeMessage, { reply_markup: mainMenuKeyboard(settings) });
      }

      // ── OTP service ───────────────────────────────────────────────────
      if (data === "menu:otp") {
        await ctx.answerCallbackQuery();
        const { text, kb } = await otpCountriesMenu(settings);
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
      }

      if (data.startsWith("otp:c:")) {
        await ctx.answerCallbackQuery();
        const countryId = data.slice("otp:c:".length);
        const apiKey = settings?.otpApiKey;
        if (!apiKey) return ctx.editMessageText("OTP not configured.");
        try {
          const r = await fetch(`https://otpget.com/api/getServices?key=${apiKey}&country=${countryId}`);
          const svcData = (await r.json()) as any[];
          const services = (Array.isArray(svcData) ? svcData : []).slice(0, 12);
          const markup = settings.otpMarkup ?? 10;
          const kb = new InlineKeyboard();
          for (const s of services) {
            const price = (Number(s.price ?? 0) * (1 + markup / 100)).toFixed(2);
            kb.text(`${s.name} — $${price}`, `otp:buy:${countryId}:${s.id}:${price}`).row();
          }
          kb.text("◀️ Back", "menu:otp");
          return ctx.editMessageText("📱 Select a service:", { reply_markup: kb });
        } catch { return ctx.editMessageText("Failed to load services."); }
      }

      if (data.startsWith("otp:buy:")) {
        await ctx.answerCallbackQuery();
        const [, , country, svcId, price] = data.split(":");
        const user = await getOrCreateUser(db, ctx.from);
        const kb = new InlineKeyboard().text("◀️ Back", "menu:main");
        return ctx.editMessageText(
          `📱 *OTP Order*\nService: ${svcId}\nPrice: *$${price}*\nYour balance: *$${user.balance.toFixed(2)}*\n\n_To place orders, top up your balance or contact support._`,
          { reply_markup: kb, parse_mode: "Markdown" }
        );
      }

      // ── Gift Cards ────────────────────────────────────────────────────
      if (data === "menu:giftcards") {
        await ctx.answerCallbackQuery();
        const { text, kb } = await gcCategoriesMenu(settings);
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
      }

      if (data.startsWith("gc:cat:")) {
        await ctx.answerCallbackQuery();
        const catId = data.slice("gc:cat:".length);
        const apiKey = settings?.giftCardApiKey;
        if (!apiKey) return ctx.editMessageText("Gift Cards not configured.");
        try {
          const r = await fetch(`https://api.g2bulk.com/api/v1/products?category=${catId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
          const pData = (await r.json()) as any;
          const products = (Array.isArray(pData) ? pData : pData.data ?? []).slice(0, 12);
          const markup = settings.giftCardMarkup ?? 10;
          const kb = new InlineKeyboard();
          for (const p of products) {
            const price = (Number(p.sale_price ?? p.price ?? 0) * (1 + markup / 100)).toFixed(2);
            kb.text(`${p.name} — $${price}`, `gc:buy:${p.id}:${price}`).row();
          }
          kb.text("◀️ Back", "menu:giftcards");
          return ctx.editMessageText("🎁 Select a Gift Card:", { reply_markup: kb });
        } catch { return ctx.editMessageText("Failed to load products."); }
      }

      if (data.startsWith("gc:buy:")) {
        await ctx.answerCallbackQuery();
        const parts = data.split(":");
        const price = parts[parts.length - 1];
        const user = await getOrCreateUser(db, ctx.from);
        const kb = new InlineKeyboard().text("◀️ Back", "menu:main");
        return ctx.editMessageText(
          `🎁 *Gift Card Order*\nPrice: *$${price}*\nYour balance: *$${user.balance.toFixed(2)}*\n\n_To place orders, top up your balance or contact support._`,
          { reply_markup: kb, parse_mode: "Markdown" }
        );
      }

      // ── TG Services ───────────────────────────────────────────────────
      if (data === "menu:tgservices") {
        await ctx.answerCallbackQuery();
        const { text, kb } = await tgCategoriesMenu(settings);
        return ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
      }

      if (data.startsWith("tg:cat:")) {
        await ctx.answerCallbackQuery();
        const cat = decodeURIComponent(data.slice("tg:cat:".length));
        const apiKey = settings?.tgServicesApiKey;
        if (!apiKey) return ctx.editMessageText("TG Services not configured.");
        try {
          const r = await fetch("https://smmmain.com/api/v2", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: apiKey, action: "services" }),
          });
          const allData = (await r.json()) as any[];
          const filtered = (Array.isArray(allData) ? allData : []).filter((s: any) => s.category === cat).slice(0, 12);
          const markup = settings.tgServicesMarkup ?? 10;
          const kb = new InlineKeyboard();
          for (const s of filtered) {
            const rate = (Number(s.rate ?? 0) * (1 + markup / 100)).toFixed(4);
            kb.text(`${s.name.slice(0, 35)} — $${rate}/1k`, `tg:svc:${s.service ?? s.id}`).row();
          }
          kb.text("◀️ Back", "menu:tgservices");
          return ctx.editMessageText(`📣 *${cat}*\nSelect a service:`, { reply_markup: kb, parse_mode: "Markdown" });
        } catch { return ctx.editMessageText("Failed to load TG services."); }
      }

      if (data.startsWith("tg:svc:")) {
        await ctx.answerCallbackQuery();
        const user = await getOrCreateUser(db, ctx.from);
        const kb = new InlineKeyboard().text("◀️ Back", "menu:main");
        return ctx.editMessageText(
          `📣 *TG Service*\nYour balance: *$${user.balance.toFixed(2)}*\n\n_To place orders, top up your balance or contact support._`,
          { reply_markup: kb, parse_mode: "Markdown" }
        );
      }

      // ── ADMIN PANEL CALLBACKS ─────────────────────────────────────────
      const authed = await isAdminAuthenticated(db, ctx.from.id, settings);
      if (!authed && data.startsWith("adm:")) {
        await ctx.answerCallbackQuery("🔒 Session expired. Use /admin", { show_alert: true });
        return;
      }

      // Main admin home
      if (data === "adm:home") {
        await ctx.answerCallbackQuery();
        return ctx.editMessageText("🔧 *ADMIN PANEL*\nSelect a section:", { reply_markup: mainAdminKeyboard(), parse_mode: "Markdown" });
      }

      if (data === "adm:exit") {
        await ctx.answerCallbackQuery();
        await db.update(adminSessionsTable).set({ isAuthenticated: false }).where(eq(adminSessionsTable.telegramId, ctx.from.id));
        return ctx.editMessageText("👋 Exited admin panel.");
      }

      // ── OTP Admin ─────────────────────────────────────────────────────
      if (data === "adm:otp:home") {
        await ctx.answerCallbackQuery();
        const stats = await getBotStats(db, "otp");
        return ctx.editMessageText("📱 *OTP Bot Admin*", { reply_markup: otpAdminKeyboard(settings, stats), parse_mode: "Markdown" });
      }

      if (data === "adm:otp:setkey") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_otp_key");
        return ctx.editMessageText("🔑 Send the new OTP API key (from otpget.com):");
      }

      if (data === "adm:otp:setmarkup") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_otp_markup");
        return ctx.editMessageText(`💹 Current OTP markup: *${settings.otpMarkup}%*\nSend new markup % (e.g. 15):`, { parse_mode: "Markdown" });
      }

      if (data === "adm:otp:toggle") {
        await ctx.answerCallbackQuery();
        const now = new Date().toISOString();
        await db.update(settingsTable).set({ otpEnabled: !settings.otpEnabled, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        const stats = await getBotStats(db, "otp");
        const s2 = await getSettings(db);
        return ctx.editMessageText(`📱 *OTP Bot Admin*\nOTP service is now ${s2.otpEnabled ? "🟢 ON" : "🔴 OFF"}`, { reply_markup: otpAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (data === "adm:otp:orders") {
        await ctx.answerCallbackQuery();
        const orders = await getRecentOrders(db, "otp");
        const kb = new InlineKeyboard().text("◀️ Back", "adm:otp:home");
        return ctx.editMessageText(`📋 *Recent OTP Orders*\n\n${formatRecentOrders(orders, "OTP")}`, { reply_markup: kb, parse_mode: "Markdown" });
      }

      // ── Gift Cards Admin ───────────────────────────────────────────────
      if (data === "adm:gc:home") {
        await ctx.answerCallbackQuery();
        const stats = await getBotStats(db, "giftcard");
        return ctx.editMessageText("🎁 *Gift Cards Admin*", { reply_markup: gcAdminKeyboard(settings, stats), parse_mode: "Markdown" });
      }

      if (data === "adm:gc:setkey") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_gc_key");
        return ctx.editMessageText("🔑 Send the new Gift Cards API key (from api.g2bulk.com):");
      }

      if (data === "adm:gc:setmarkup") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_gc_markup");
        return ctx.editMessageText(`💹 Current Gift Cards markup: *${settings.giftCardMarkup}%*\nSend new markup %:`, { parse_mode: "Markdown" });
      }

      if (data === "adm:gc:toggle") {
        await ctx.answerCallbackQuery();
        const now = new Date().toISOString();
        await db.update(settingsTable).set({ giftCardEnabled: !settings.giftCardEnabled, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        const stats = await getBotStats(db, "giftcard");
        const s2 = await getSettings(db);
        return ctx.editMessageText(`🎁 *Gift Cards Admin*\nGift Cards service is now ${s2.giftCardEnabled ? "🟢 ON" : "🔴 OFF"}`, { reply_markup: gcAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (data === "adm:gc:orders") {
        await ctx.answerCallbackQuery();
        const orders = await getRecentOrders(db, "giftcard");
        const kb = new InlineKeyboard().text("◀️ Back", "adm:gc:home");
        return ctx.editMessageText(`📋 *Recent Gift Card Orders*\n\n${formatRecentOrders(orders, "Gift Cards")}`, { reply_markup: kb, parse_mode: "Markdown" });
      }

      // ── TG Services Admin ──────────────────────────────────────────────
      if (data === "adm:tg:home") {
        await ctx.answerCallbackQuery();
        const stats = await getBotStats(db, "tgservice");
        return ctx.editMessageText("📣 *TG Services Admin*", { reply_markup: tgAdminKeyboard(settings, stats), parse_mode: "Markdown" });
      }

      if (data === "adm:tg:setkey") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_tg_key");
        return ctx.editMessageText("🔑 Send the new TG Services API key (from smmmain.com):");
      }

      if (data === "adm:tg:setmarkup") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_tg_markup");
        return ctx.editMessageText(`💹 Current TG markup: *${settings.tgServicesMarkup}%*\nSend new markup %:`, { parse_mode: "Markdown" });
      }

      if (data === "adm:tg:toggle") {
        await ctx.answerCallbackQuery();
        const now = new Date().toISOString();
        await db.update(settingsTable).set({ tgServicesEnabled: !settings.tgServicesEnabled, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        const stats = await getBotStats(db, "tgservice");
        const s2 = await getSettings(db);
        return ctx.editMessageText(`📣 *TG Services Admin*\nTG Services is now ${s2.tgServicesEnabled ? "🟢 ON" : "🔴 OFF"}`, { reply_markup: tgAdminKeyboard(s2, stats), parse_mode: "Markdown" });
      }

      if (data === "adm:tg:orders") {
        await ctx.answerCallbackQuery();
        const orders = await getRecentOrders(db, "tgservice");
        const kb = new InlineKeyboard().text("◀️ Back", "adm:tg:home");
        return ctx.editMessageText(`📋 *Recent TG Service Orders*\n\n${formatRecentOrders(orders, "TG Services")}`, { reply_markup: kb, parse_mode: "Markdown" });
      }

      // ── Global Settings Admin ──────────────────────────────────────────
      if (data === "adm:global:home") {
        await ctx.answerCallbackQuery();
        const [{ total }] = await db.select({ total: count() }).from(usersTable);
        return ctx.editMessageText("⚙️ *Global Settings*", { reply_markup: globalAdminKeyboard(total, settings.botEnabled), parse_mode: "Markdown" });
      }

      if (data === "adm:global:setchannel") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_channel");
        const cur = settings.requiredChannelId ?? "not set";
        return ctx.editMessageText(`📢 *Required Channel*\nCurrent: \`${cur}\`\n\nSend channel username (e.g. @mychannel) or ID (e.g. -1001234567890).\nSend "none" to disable.`, { parse_mode: "Markdown" });
      }

      if (data === "adm:global:setwelcome") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_welcome");
        return ctx.editMessageText(`👋 *Welcome Message*\nCurrent:\n_${settings.welcomeMessage}_\n\nSend new welcome message:`, { parse_mode: "Markdown" });
      }

      if (data === "adm:global:broadcast") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_broadcast");
        return ctx.editMessageText("📣 *Broadcast*\nSend the message to broadcast to all users (Markdown supported):", { parse_mode: "Markdown" });
      }

      if (data === "adm:global:finduser") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_finduser");
        return ctx.editMessageText("🔍 *Find User*\nSend Telegram ID or @username:", { parse_mode: "Markdown" });
      }

      if (data === "adm:global:addbal") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_addbal_id");
        return ctx.editMessageText("💰 *Add Balance*\nSend the user's Telegram ID:", { parse_mode: "Markdown" });
      }

      if (data === "adm:global:ban") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_ban_id");
        return ctx.editMessageText("🚫 *Ban User*\nSend Telegram ID of user to ban:", { parse_mode: "Markdown" });
      }

      if (data === "adm:global:unban") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_unban_id");
        return ctx.editMessageText("✅ *Unban User*\nSend Telegram ID of user to unban:", { parse_mode: "Markdown" });
      }

      if (data === "adm:global:togglebot") {
        await ctx.answerCallbackQuery();
        const now = new Date().toISOString();
        await db.update(settingsTable).set({ botEnabled: !settings.botEnabled, updatedAt: now }).where(eq(settingsTable.id, settings.id));
        const s2 = await getSettings(db);
        const [{ total }] = await db.select({ total: count() }).from(usersTable);
        return ctx.editMessageText(`⚙️ *Global Settings*\nBot is now ${s2.botEnabled ? "🟢 ONLINE" : "🔴 OFFLINE"}`, { reply_markup: globalAdminKeyboard(total, s2.botEnabled), parse_mode: "Markdown" });
      }

      if (data === "adm:global:setpwd") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_new_password");
        return ctx.editMessageText("🔑 *Change Admin Password*\nSend new password:", { parse_mode: "Markdown" });
      }

      if (data === "adm:global:addadmin") {
        await ctx.answerCallbackQuery();
        await setAdminAwaiting(db, ctx.from.id, "await_add_admin_id");
        return ctx.editMessageText("👑 *Add Admin*\nSend Telegram ID to grant permanent admin access:", { parse_mode: "Markdown" });
      }

      // Inline user action buttons (from find-user flow)
      if (data.startsWith("adm:user:addbal:")) {
        await ctx.answerCallbackQuery();
        const userId = data.split(":")[3];
        await setAdminAwaiting(db, ctx.from.id, `await_addbal_for:${userId}`);
        return ctx.editMessageText("💰 Send amount to add:");
      }

      if (data.startsWith("adm:user:ban:")) {
        await ctx.answerCallbackQuery();
        const userId = parseInt(data.split(":")[3]);
        const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        if (!target) return ctx.editMessageText("❌ User not found.");
        await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.id, userId));
        return ctx.editMessageText(`🚫 ${target.firstName} has been banned.`);
      }

      if (data.startsWith("adm:user:unban:")) {
        await ctx.answerCallbackQuery();
        const userId = parseInt(data.split(":")[3]);
        const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        if (!target) return ctx.editMessageText("❌ User not found.");
        await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.id, userId));
        return ctx.editMessageText(`✅ ${target.firstName} has been unbanned.`);
      }

      await ctx.answerCallbackQuery();
    });

    const handler = webhookCallback(bot, "cloudflare-mod");
    return handler(request);
  },
};
