// Обёртка над Anthropic SDK: таймаут, понятные причины ошибок, server-side fallback.
const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;

class LlmError extends Error {
  constructor(reason, cause) {
    super(reason);
    // По-русски, для мастера и владельца точки. Без названий провайдера и модели:
    // их видит только тот, кто обслуживает бота, — в логах (см. Llm.create).
    this.reason = reason;
    this.cause = cause;
  }
}

function explain(e, timedOut) {
  if (timedOut || e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIUserAbortError)
    return "ИИ не ответил вовремя (таймаут)";
  if (e instanceof Anthropic.RateLimitError) return "ИИ перегружен: превышен лимит запросов";
  if (e instanceof Anthropic.AuthenticationError) return "ИИ временно недоступен (ошибка ключа доступа)";
  if (e instanceof Anthropic.PermissionDeniedError) return "ИИ временно недоступен (нет доступа)";
  if (e instanceof Anthropic.BadRequestError) return "ошибка запроса к ИИ";
  if (e instanceof Anthropic.APIConnectionError) return "нет связи с ИИ";
  if (e instanceof Anthropic.APIError) return `ИИ временно недоступен (${e.status || "ошибка"})`;
  return "ошибка ИИ";
}

class Llm {
  constructor({ apiKey, baseURL, model, fallbacks = true, log = console }) {
    this.client = new Anthropic({ apiKey, baseURL: baseURL || undefined, maxRetries: 1 });
    this.model = model;
    this.fallbacks = fallbacks;
    this.log = log;
  }

  // params — тело Messages API без model. Бросает LlmError с причиной по-русски.
  async create(params, { timeoutMs = 30000 } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      return await this.send(params, ctrl.signal, timeoutMs);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      // Подробности (провайдер, модель, текст ошибки API) — только в лог
      this.log.error(`LLM (Anthropic, ${this.model}):`, e?.name || "", e?.status || "", e?.message);
      throw new LlmError(explain(e, timedOut), e);
    } finally {
      clearTimeout(timer);
    }
  }

  async send(params, signal, timeoutMs) {
    const body = { model: this.model, ...params };
    // Если модель откажет по соображениям безопасности, API сам повторит запрос
    // на рекомендованной запасной модели.
    if (this.fallbacks) {
      body.betas = ["server-side-fallback-2026-07-01"];
      body.fallbacks = "default";
    }
    try {
      return await this.client.beta.messages.create(body, { signal, timeout: timeoutMs + 1000 });
    } catch (e) {
      if (this.fallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message || "")) {
        this.log.warn("Server-side fallback недоступен для этой модели/ключа — отключаю.");
        this.fallbacks = false;
        delete body.betas;
        delete body.fallbacks;
        return await this.client.beta.messages.create(body, { signal, timeout: timeoutMs + 1000 });
      }
      throw e;
    }
  }
}

function textOf(resp) {
  return (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

module.exports = { Llm, LlmError, textOf, parseJson, Anthropic };
