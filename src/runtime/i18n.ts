import type { UserPreferences } from "../storage/types.js";

const messages = {
  en: {
    working: "Working…",
    stopped: "Stopped.",
    noActiveTurn: "There is no active turn to stop.",
    correctionLate: "That edit arrived after processing started. Please send the correction as a new message.",
    failed: "The request failed. Use `!retry` to try the last message again.",
    busy: "This conversation is already processing a message.",
    compacted: "Conversation memory was compacted.",
    forked: "Started a new conversation thread.",
    retryMissing: "There is no failed message to retry.",
    denied: "You are not authorized to use this bot.",
  },
  ru: {
    working: "Работаю…",
    stopped: "Остановлено.",
    noActiveTurn: "Сейчас нет активного запроса.",
    correctionLate: "Изменение пришло после начала обработки. Отправьте исправление новым сообщением.",
    failed: "Не удалось обработать запрос. Используйте `!retry`, чтобы повторить последнее сообщение.",
    busy: "В этом диалоге уже обрабатывается сообщение.",
    compacted: "Память диалога сжата.",
    forked: "Создана новая ветка диалога.",
    retryMissing: "Нет неудачного сообщения для повторения.",
    denied: "У вас нет доступа к этому боту.",
  },
} as const;

export type MessageKey = keyof typeof messages.en;

export function t(preferences: UserPreferences, key: MessageKey): string {
  return messages[preferences.locale][key];
}

export function help(locale: "en" | "ru", owner: boolean): string {
  if (locale === "ru") {
    return [
      "**Команды**",
      "`!lang en|ru` — язык",
      "`!timezone ±HH:MM` — часовой пояс",
      "`!stream on|off` — потоковые обновления",
      "`!stop` — остановить текущий запрос",
      "`!fork [название]` — новая ветка диалога",
      "`!compact` — сжать память диалога",
      "`!retry` — повторить неудачный запрос",
      ...(owner ? ["`!allow @user:server`, `!deny @user:server`, `!users` — управление доступом"] : []),
    ].join("\n\n");
  }
  return [
    "**Commands**",
    "`!lang en|ru` — language",
    "`!timezone ±HH:MM` — timezone",
    "`!stream on|off` — streaming updates",
    "`!stop` — stop the active request",
    "`!fork [title]` — create a new conversation thread",
    "`!compact` — compact conversation memory",
    "`!retry` — retry the last failed request",
    ...(owner ? ["`!allow @user:server`, `!deny @user:server`, `!users` — access control"] : []),
  ].join("\n\n");
}
