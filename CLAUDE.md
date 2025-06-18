# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Local Development:**
- `npm run dev` - Start development server on port 3000
- `npm run build` - Build for production 
- `npm run preview` - Preview production build on port 27027
- `npm run serve` - Serve production build on port 27027 with host binding

**Docker Deployment:**
- `docker buildx build --platform linux/amd64 -t mossly/transcribe-locally:v1.1.0 -t mossly/transcribe-locally:latest --push .` - Build multi-arch image
- `docker-compose up` - Run with Docker Compose (uses versioned tag)
- Production deployment uses port 27027
- Always use semantic versioning tags (v1.1.0, v1.2.0, etc.) for TrueNAS compatibility

## Architecture Overview

This is a **client-side WebGPU-powered transcription application** that runs OpenAI Whisper models entirely in the browser with no server-side processing.

**Core Architecture:**
- **Main App (App.jsx)**: React component managing recording state, audio processing, and UI
- **Web Worker (worker.js)**: Isolated thread running Whisper model inference using @huggingface/transformers
- **AudioVisualizer**: Real-time audio waveform visualization using Canvas API
- **Browser APIs**: MediaRecorder for audio capture, AudioContext for processing, WebGPU for model acceleration

**Key Technical Details:**
- Uses WebGPU for AI model acceleration (falls back gracefully if unavailable)
- Whisper model: `onnx-community/whisper-medium-ONNX` (~500MB download)
- Audio processing: 16kHz sampling rate, 30-second maximum chunks
- Real-time transcription with final transcript compilation
- All model inference happens client-side - no server costs for AI processing

**State Management Flow:**
1. User clicks "Load Model" → Worker downloads Whisper model from Hugging Face
2. User starts recording → MediaRecorder captures audio → AudioContext processes
3. Audio chunks sent to Worker → Whisper processes → Returns transcription
4. Real-time preview updates during recording, final transcript on stop

**Docker Configuration:**
- Multi-stage build: Node.js build → Nginx production
- Nginx serves on port 27027 with WebGPU/WASM optimizations
- **Critical**: No strict CORS headers (`Cross-Origin-Embedder-Policy`) to ensure Web Worker compatibility through reverse proxies
- WASM files served with correct `application/wasm` MIME type

**Browser Requirements:**
- HTTPS or localhost (required for microphone access)
- WebGPU support recommended (Chrome/Edge with experimental features)
- Modern browser with Web Workers and MediaRecorder API support

## Important Implementation Notes

**Reverse Proxy Compatibility:**
The nginx configuration deliberately omits strict CORS headers that would prevent Web Workers from loading through reverse proxies. If re-adding security headers, test thoroughly with reverse proxy setups.

**Audio Processing:**
Audio chunks are processed in overlapping segments to maintain real-time performance. The `MAX_SAMPLES` constant (480,000 samples = 30 seconds at 16kHz) defines the maximum processing window.

**Model Loading:**
The Whisper model downloads directly from Hugging Face to the user's browser - the server never handles model files or inference, keeping bandwidth costs minimal.