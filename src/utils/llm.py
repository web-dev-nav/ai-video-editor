"""Provider-agnostic text completion for the AI Director step.

Supports three providers, selected by config["director"]["provider"]:
  - "anthropic"  — official ``anthropic`` SDK, key from ANTHROPIC_API_KEY
  - "openai"     — official ``openai`` SDK (Responses API), key from OPENAI_API_KEY
  - "openrouter" — the repo's existing httpx client, key from OPENROUTER_API_KEY
"""

from __future__ import annotations

import os

DEFAULT_MODELS = {
    "anthropic": "claude-opus-5",
    "openai": "gpt-5",
    "openrouter": "anthropic/claude-sonnet-4",
}

KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


class LLMError(RuntimeError):
    pass


def available_providers() -> dict[str, bool]:
    """Which providers have a key configured in the environment."""
    return {p: bool(os.environ.get(env)) for p, env in KEY_ENV.items()}


def complete(
    prompt: str,
    system: str,
    provider: str,
    model: str | None = None,
    max_tokens: int = 16000,
) -> tuple[str, dict]:
    """Return (response_text, usage_dict) from the chosen provider."""
    provider = (provider or "anthropic").lower()
    model = model or DEFAULT_MODELS.get(provider)
    if not model:
        raise LLMError(f"Unknown provider '{provider}'")
    if not os.environ.get(KEY_ENV.get(provider, "")):
        raise LLMError(
            f"{KEY_ENV.get(provider, provider)} is not set. Add it to .env or the environment "
            f"to use the '{provider}' provider."
        )
    if provider == "anthropic":
        return _anthropic(prompt, system, model, max_tokens)
    if provider == "openai":
        return _openai(prompt, system, model, max_tokens)
    if provider == "openrouter":
        return _openrouter(prompt, system, model, max_tokens)
    raise LLMError(f"Unknown provider '{provider}'")


def _anthropic(prompt: str, system: str, model: str, max_tokens: int) -> tuple[str, dict]:
    import anthropic

    client = anthropic.Anthropic()
    try:
        # Streaming keeps long transcripts + large max_tokens clear of HTTP timeouts.
        # Thinking is adaptive by default on current models; no explicit config needed.
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise LLMError(f"Anthropic: invalid API key ({e.message})") from e
    except anthropic.NotFoundError as e:
        raise LLMError(f"Anthropic: unknown model '{model}' ({e.message})") from e
    except anthropic.RateLimitError as e:
        raise LLMError(f"Anthropic: rate limited ({e.message})") from e
    except anthropic.APIStatusError as e:
        raise LLMError(f"Anthropic API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise LLMError(f"Anthropic: connection error ({e})") from e

    if msg.stop_reason == "refusal":
        detail = getattr(msg, "stop_details", None)
        raise LLMError(f"Anthropic declined the request ({getattr(detail, 'category', 'refusal')})")
    text = "".join(b.text for b in msg.content if b.type == "text")
    usage = {
        "input_tokens": msg.usage.input_tokens,
        "output_tokens": msg.usage.output_tokens,
        "model": msg.model,
    }
    return text, usage


def _openai(prompt: str, system: str, model: str, max_tokens: int) -> tuple[str, dict]:
    import openai

    client = openai.OpenAI()
    try:
        resp = client.responses.create(
            model=model,
            instructions=system,
            input=prompt,
            max_output_tokens=max_tokens,
        )
    except openai.AuthenticationError as e:
        raise LLMError(f"OpenAI: invalid API key ({e})") from e
    except openai.NotFoundError as e:
        raise LLMError(f"OpenAI: unknown model '{model}' ({e})") from e
    except openai.RateLimitError as e:
        raise LLMError(f"OpenAI: rate limited ({e})") from e
    except openai.APIStatusError as e:
        raise LLMError(f"OpenAI API error {e.status_code}: {e}") from e
    except openai.APIConnectionError as e:
        raise LLMError(f"OpenAI: connection error ({e})") from e

    text = resp.output_text
    u = getattr(resp, "usage", None)
    usage = {
        "input_tokens": getattr(u, "input_tokens", None),
        "output_tokens": getattr(u, "output_tokens", None),
        "model": getattr(resp, "model", model),
    }
    return text, usage


def _openrouter(prompt: str, system: str, model: str, max_tokens: int) -> tuple[str, dict]:
    from .openrouter import OpenRouterError, chat_completion

    try:
        text = chat_completion(prompt=prompt, model=model, system=system, max_tokens=max_tokens)
    except OpenRouterError as e:
        raise LLMError(str(e)) from e
    return text, {"model": model}
