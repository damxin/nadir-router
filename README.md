# Nadir Router

Smart LLM Router for LiteLLM with intelligent request classification.

## Features

- 🧠 **Intelligent Routing** - 15-dimension scoring classifier for request complexity
- 🔄 **Fallback Chains** - Automatic failover to backup models
- 📡 **SSE Passthrough** - Direct streaming, compatible with OpenClaw Gateway
- ⚙️ **YAML Configuration** - Easy configuration via `config.yaml`
- 🚀 **LiteLLM Compatible** - Works as a drop-in proxy for LiteLLM

## Installation

```bash
git clone https://github.com/damxin/nadir-router.git
cd nadir-router
npm install
npm run build
```

## Configuration

1. Copy the example config:
```bash
cp config.yaml.example config.yaml
```

2. Edit `config.yaml` with your settings:
```yaml
server:
  port: 8856
  host: "127.0.0.1"

litellm:
  base_url: "YOUR_LITELLM_BASE_URL"
  api_key: "YOUR_LITELLM_API_KEY"
  timeout_ms: 180000

models:
  your-model-1:
    context_window: 128000
  # Add your models...

routing:
  auto:
    SIMPLE:
      primary: "your-cheapest-model"
      fallback: ["backup-model"]
    # Configure all tiers...
```

## Running

```bash
# Development
npm run dev

# Production
npm run build
npm start

# Or use systemd
sudo cp nadir-router.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable nadir-router
sudo systemctl start nadir-router
```

## Usage

### Routing Profiles

| Profile | Description |
|---------|-------------|
| `nadir/auto` | Intelligent routing (default) |
| `nadir/eco` | Cheapest models |
| `nadir/premium` | Best quality |
| `nadir/free` | Free models only |

### API Endpoints

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Chat completions (OpenAI compatible)

### Example Request

```bash
curl http://localhost:8856/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nadir/auto",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Routing Logic

Requests are classified into tiers based on:

| Tier | Score | Description |
|------|-------|-------------|
| SIMPLE | < 0.0 | Simple questions, greetings |
| MEDIUM | 0.0 - 0.3 | Code, technical questions |
| COMPLEX | 0.3 - 0.5 | Architecture, multi-step tasks |
| REASONING | ≥ 0.5 | Proofs, mathematical derivations |

### Classification Dimensions

- Token count
- Code keywords (function, class, import...)
- Reasoning markers (prove, theorem, derive...)
- Technical terms (architecture, distributed...)
- Creative markers (story, poem...)
- And 10 more dimensions...

## Architecture

```
Client Request
     ↓
┌─────────────────┐
│  nadir-router   │
│  ┌───────────┐  │
│  │ Classifier│  │ → Tier (SIMPLE/MEDIUM/COMPLEX/REASONING)
│  └───────────┘  │
│  ┌───────────┐  │
│  │  Selector │  │ → Model from config.yaml
│  └───────────┘  │
└────────┬────────┘
         ↓
    ┌─────────┐
    │ LiteLLM │
    └────┬────┘
         ↓
    ┌─────────┐
    │   LLM   │
    └─────────┘
```

## Based On

Routing logic inspired by [ClawRouter](https://github.com/BlockRunAI/ClawRouter).

## License

MIT
