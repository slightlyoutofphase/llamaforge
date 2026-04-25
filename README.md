# LlamaForge

LlamaForge is a professional-grade, specialized local LLM graphical workspace designed for power users and researchers. It bridges the gap between high-performance backends (llama-server) and the nuanced needs of structured inference, multi-modality, and local model management.

## Key Features

- **High-Performance Backend**: Built on Bun and `llama-server`.
- **GGUF Native Registry**: Auto-scans and populates metadata for local models.
- **Multimodal Support**: Full support for vision (MMProj) and audio (En-Gemma) encoders.
- **Structured Output**: GUI builders for tool-calling and JSON schemas.
- **Hybrid Chat Architecture**: Real-time thinking tag support and branchable histories.
- **Hardware Optimized**: Automatic calibration based on your system's VRAM and RAM.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime installed.
- `llama-server` binary available (from llama.cpp).

### Development

1. Install dependencies:
   ```bash
   bun install
   ```
2. Start the development server:
   ```bash
   bun run dev
   ```
3. Open `http://localhost:3000` in your browser.

## Documentation

To generate the technical documentation, run:
```bash
bun run docs
```
The output will be available in the `docs/` directory.

## License

MIT
