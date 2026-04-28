"""Simple REPL client to use a local Ollama model for coding help.

Run:
    .venv/Scripts/python.exe server/ollama_coding_agent.py --model qwen2.5vl:7b

Type a prompt and press Enter; Ctrl-C to exit.
"""
from __future__ import annotations

import argparse
import httpx
import sys

DEFAULT_OLLAMA = "http://localhost:11434"


def chat(prompt: str, model: str, ollama_url: str) -> str:
    body = {
        "model": model,
        "stream": False,
        "format": "text",
        "messages": [{"role": "user", "content": prompt}],
    }
    with httpx.Client(timeout=300.0) as client:
        r = client.post(f"{ollama_url}/api/chat", json=body)
        r.raise_for_status()
        msg = r.json()
        return (msg.get("message", {}) or {}).get("content", "") or ""


def main() -> None:
    p = argparse.ArgumentParser(description="REPL client for local Ollama model")
    p.add_argument("--model", default="qwen2.5vl:7b")
    p.add_argument("--ollama-url", default=DEFAULT_OLLAMA)
    args = p.parse_args()

    print(f"Ollama coding REPL — model={args.model} @ {args.ollama_url}")
    print("Type prompts. Ctrl-C to quit.")
    try:
        while True:
            prompt = input("Prompt> ")
            if not prompt.strip():
                continue
            try:
                out = chat(prompt, args.model, args.ollama_url)
            except Exception as e:
                print(f"Error: {e}")
                continue
            print('\n--- response ---')
            print(out)
            print('----------------\n')
    except KeyboardInterrupt:
        print('\nExiting.')
        sys.exit(0)


if __name__ == "__main__":
    main()
