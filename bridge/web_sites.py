"""Web-chat sites that TEAMYRA Desktop runs as workers.

One table for the core: each site's provider id, its readiness folder
(ROOT/<folder>/status.json, also blocked for workspace tools), its display
name, the built-in worker for its default account, and the worker-id prefix
for further accounts under profiles/<provider>/ (with "accounts_from", the
accounts of another provider: Gemini runs in the Google Media accounts). The desktop has the matching
site descriptions (apps/desktop/src/*-web-provider.js).
"""

WEB_SITES = {
    "chatgpt-web": {"folder": "chatgpt", "name": "ChatGPT", "builtin": "chatgpt-normal",
                    "label": "ChatGPT Normal", "prefix": "chatgpt-", "priority": 250},
    "muse-web": {"folder": "muse", "name": "Muse", "builtin": "muse-normal",
                 "label": "Muse", "prefix": "muse-", "priority": 260},
    "deepseek-web": {"folder": "deepseek", "name": "DeepSeek", "builtin": "deepseek-normal",
                     "label": "DeepSeek", "prefix": "deepseek-", "priority": 270},
    "grok-web": {"folder": "grok", "name": "Grok", "builtin": "grok-normal",
                 "label": "Grok", "prefix": "grok-", "priority": 280},
    "qwen-web": {"folder": "qwen", "name": "Qwen", "builtin": "qwen-normal",
                 "label": "Qwen", "prefix": "qwen-", "priority": 290},
    "glm-web": {"folder": "glm", "name": "GLM", "builtin": "glm-normal",
                "label": "GLM (Z.ai)", "prefix": "glm-", "priority": 300},
    # Gemini has no accounts of its own: each Google Media account (signed in
    # under Google Media, profiles/google-media/<id>) is one Gemini worker,
    # in that account's browser profile. See docs/GEMINI_WEB_AGENT.md.
    "gemini-web": {"folder": "gemini", "name": "Gemini", "builtin": "gemini-normal",
                   "label": "Gemini", "prefix": "gemini-", "priority": 310,
                   "accounts_from": "google-media"},
}

WEB_PROVIDERS = tuple(WEB_SITES)


def site_name(provider):
    """The site's display name, e.g. "Muse" for muse-web."""
    return (WEB_SITES.get(provider) or WEB_SITES["chatgpt-web"])["name"]
