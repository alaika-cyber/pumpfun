# 🧠 Laya & Jev System 1 Decision Architecture & Win-Rate Synergy

The pump.fun algorithmic trading agent is powered by **Laya** (`convaiinnovations/laya`), a state-of-the-art non-autoregressive **System 1 Decision Engine** based on ModernBERT-large (421M params), with full **Jev wire-compatibility** and an automated **Dual-Model Consensus Engine** (`aiBrain.ts`) designed to maximize the trading win rate.

- **Hugging Face Model:** [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya)
- **GitHub Repository:** [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)

---

## 1. Why Laya is the Main Decision Model

Traditional generative LLMs (GPT-4, Claude, Gemini) generate text token-by-token, taking **2,000ms – 6,000ms** with hallucination risks. On Pump.fun, token launches trade in sub-second blocks, making generative text models obsolete.

### Laya Core Advantages:
1. **Ultra-Low Latency (~33ms on GPU / sub-200ms on CPU)**: Non-autoregressive forward pass evaluates decisions in a single pass without token generation loops.
2. **Criteria-Based Prompt Formulation**: Laya uses explicit `criteria` descriptions per choice option and noul. Unlike standard LLMs that rely on ambiguous labels, explicit criteria raise decision accuracy from ~36% to **76.6%+** on benchmarked distributions.
3. **Calibrated Probabilities**: Trained with RLCD against strictly proper scoring rules, producing statistically honest confidence values (`answer_confidence`).
4. **Zero API Cost & 100% Offline**: Runs locally via `laya-serve` (`pip install "laya[serve]"`), Docker, or local ONNX runtime.

---

## 2. Laya + Jev Compatibility Matrix

Laya and Jev share the same System 1 decision lineage. The agent provides seamless cross-compatibility across endpoints:

| Endpoint Type | Primary Model | Wire Protocol | Feature Support |
|---|---|---|---|
| **`http://localhost:8000/predict`** | **`convaiinnovations/laya`** *(Default)* | Laya Native JSON API | Semantic state context, criteria mapping, normalized entropy & answer confidence. |
| **`http://localhost:8000/v1/systemone`** | **Laya (`laya.serve`) or Jev** | Jev Wire Protocol | `POST /v1/systemone` compatible with TypeSafe Jev API and local-jev runners. |
| **Consensus Mode (`AI_CONSENSUS=true`)** | **Laya + Jev Dual Ensemble** | Dual Parallel Query | Evaluates both models simultaneously to filter false breakouts and boost win rate. |
| **`builtin`** | Built-in Neural Engine | Local Heuristics | Zero-downtime offline fallback matrix. |

---

## 3. How Dual Consensus Maximizes the Win Rate

In bonding curve trading, false breakouts and stealth developer rugs are the primary sources of capital erosion. The agent pairs Laya's semantic strengths with Jev's calibrated scoring:

```
[New Token Detected on Pump.fun]
                │
       ┌────────┴────────┐
       ▼                 ▼
[Query Laya Engine]  [Query Jev System One]
(ModernBERT-large)   (Calibrated Scoring)
       │                 │
       └────────┬────────┘
                ▼
  [Synergistic Consensus Fusion]
                │
   ┌────────────┴────────────┐
   ▼                         ▼
[Both Agree BUY]     [Risk or Divergence]
• +8% Synergy Bonus  • Auto-Veto & Skip
• Promoted Conviction • 0.0x Position Size
• Super Snipe Entry  • Capital Preserved
```

### Consensus Decision Matrix:
1. **Double Confirmation (Both BUY)**:
   - Grants an automated **+8% confidence synergy bonus** (capped at 99%).
   - Promotes the conviction tier to `SUPER_SNIPE` ($1.6\times$ dynamic Kelly size) or `HIGH_CONVICTION` ($1.3\times$).
   - Only enters trades backed by dual independent verification.
2. **Defensive Veto (Risk Flagged)**:
   - If either model detects `HIGH_DEV_RISK` or `SPAM_RUG_PATTERN`, the setup is immediately skipped (`0.0x` size).
   - This eliminates serial ruggers that bypass basic single-stage heuristics.

---

## 4. Typed Decision Criteria Schema

Laya evaluates opportunities using 4 typed questions equipped with explicit criteria:

```json
{
  "should_buy": {
    "type": "noul",
    "instructions": "Should the trading agent buy/snipe this token immediately on pump.fun?",
    "criteria": {
      "true": "clean dev, punchy ticker, verified narrative, low concentration, and high breakout probability",
      "false": "suspicious dev, excessive initial buy, spam ticker, or elevated rug risk"
    },
    "labels": { "true": "BUY", "false": "SKIP" }
  },
  "conviction_tier": {
    "type": "choice",
    "instructions": "Determine conviction tier for position sizing and risk control.",
    "criteria": {
      "SUPER_SNIPE": "top-tier conviction, verified socials/docs, clean dev history, strong viral meme or tech narrative",
      "HIGH_CONVICTION": "solid momentum, safe dev buy size, active community interest, favorable volume velocity",
      "STANDARD": "ordinary fair launch satisfying baseline anti-rug filters",
      "SPECULATIVE": "low conviction, questionable dev history, high dump risk, avoid entry"
    },
    "options": ["SUPER_SNIPE", "HIGH_CONVICTION", "STANDARD", "SPECULATIVE"]
  },
  "risk_level": {
    "type": "choice",
    "instructions": "Assess the risk profile and red flags for this token.",
    "criteria": {
      "SAFE_CLEAN": "verified socials, clean dev history, fair launch metrics, organic volume",
      "BALANCED": "moderate risk profile with normal pump.fun market parameters",
      "HIGH_DEV_RISK": "dev reputation warning, excessive initial buy, or high holder concentration",
      "SPAM_RUG_PATTERN": "clear spam ticker, serial rugger pattern, or blacklisted dev"
    },
    "options": ["SAFE_CLEAN", "BALANCED", "HIGH_DEV_RISK", "SPAM_RUG_PATTERN"]
  },
  "target_take_profit": {
    "type": "choice",
    "instructions": "Optimal take-profit milestone based on sector velocity.",
    "criteria": {
      "TP_45": "fast 45% scalp target for rapid meme rotations",
      "TP_75": "75% target for AI, DePIN, and tech narrative trends",
      "TP_100": "100% 2x milestone for high-conviction breakout setups",
      "TP_150": "150% 2.5x milestone for hyper-viral market runners",
      "TP_200": "200% 3x moonbag for alpha target leaders"
    },
    "options": ["TP_45", "TP_75", "TP_100", "TP_150", "TP_200"]
  }
}
```

---

## 5. Local Setup Instructions

To serve Laya locally:
```bash
# 1. Install Laya with HTTP server support
pip install "laya[serve]"

# 2. Start the server (binds 0.0.0.0:8000, preloading checkpoints)
LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve
```

Configure in `.env`:
```env
AI_PROVIDER=laya
AI_MODEL=convaiinnovations/laya
LAYA_URL=http://localhost:8000/predict
JEV_URL=http://localhost:8000/v1/systemone
AI_CONSENSUS=true
```
