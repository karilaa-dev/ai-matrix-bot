import { help, t } from "./i18n.js";
import type { AccessController } from "./access.js";
import type { MatrixStore } from "../storage/sqlite.js";

export type CommandAction =
  | { kind: "reply"; markdown: string }
  | { kind: "stop" }
  | { kind: "fork"; title?: string }
  | { kind: "compact" }
  | { kind: "retry" };

function timezone(value: string): number | undefined {
  const normalized = value.toUpperCase().replace(/^UTC/, "");
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(normalized);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

export class CommandHandler {
  readonly #store: MatrixStore;
  readonly #access: AccessController;

  constructor(store: MatrixStore, access: AccessController) {
    this.#store = store;
    this.#access = access;
  }

  async handle(sender: string, body: string): Promise<CommandAction | undefined> {
    if (!body.startsWith("!")) return undefined;
    const [rawCommand = "", ...args] = body.trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const preferences = this.#store.getPreferences(sender);

    if (command === "!help" || command === "!start") {
      return { kind: "reply", markdown: help(preferences.locale, this.#access.isOwner(sender)) };
    }
    if (command === "!lang") {
      const locale = args[0];
      if (locale !== "en" && locale !== "ru") return { kind: "reply", markdown: "Usage: `!lang en|ru`" };
      this.#store.savePreferences({ ...preferences, locale });
      return { kind: "reply", markdown: locale === "ru" ? "Язык изменён на русский." : "Language changed to English." };
    }
    if (command === "!timezone") {
      const offset = timezone(args[0] ?? "");
      if (offset === undefined) return { kind: "reply", markdown: "Usage: `!timezone ±HH:MM`" };
      this.#store.savePreferences({ ...preferences, timezoneOffsetMinutes: offset });
      return { kind: "reply", markdown: `Timezone set to UTC${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}.` };
    }
    if (command === "!stream") {
      if (args[0] !== "on" && args[0] !== "off") return { kind: "reply", markdown: "Usage: `!stream on|off`" };
      const streamEnabled = args[0] === "on";
      this.#store.savePreferences({ ...preferences, streamEnabled });
      return { kind: "reply", markdown: `Streaming ${streamEnabled ? "enabled" : "disabled"}.` };
    }
    if (command === "!stop") return { kind: "stop" };
    if (command === "!fork") {
      const title = args.join(" ").trim();
      return { kind: "fork", ...(title ? { title } : {}) };
    }
    if (command === "!compact") return { kind: "compact" };
    if (command === "!retry") return { kind: "retry" };

    if (command === "!allow") {
      const mxid = args[0] ?? "";
      return {
        kind: "reply",
        markdown: this.#access.allow(sender, mxid) ? `Allowed ${mxid}.` : "Usage (owner only): `!allow @user:server`",
      };
    }
    if (command === "!deny") {
      const mxid = args[0] ?? "";
      return {
        kind: "reply",
        markdown: await this.#access.deny(sender, mxid) ? `Denied ${mxid}.` : "Usage (owner only): `!deny @user:server`",
      };
    }
    if (command === "!users") {
      const users = this.#access.list(sender);
      return { kind: "reply", markdown: users ? users.map((mxid) => `- ${mxid}`).join("\n") : t(preferences, "denied") };
    }
    return { kind: "reply", markdown: help(preferences.locale, this.#access.isOwner(sender)) };
  }
}
