# STRICTLY PROHIBITED:
- ANY use of PowerShell scripts WHATSOEVER for tasks that specifically COULD more easily be accomplished via the specific native Agent tools that are available to you here in the specific context of the Cursor IDE environment. Other use of Powershell is acceptable if actually necessary.
- Stub code, placeholder code, todos, simplifications, and any other kind of deficient code.
- Using any Git command whatsoever without explicit user permission (which you may directly request from them if necessary)
# REMEMBER:
- This **IS** a real implementation. This **IS** a full implementation. The user will immediately notice any failure to implement the project correctly and fully.
- You **ABSOLUTELY MUST AT ALL TIMES** consider edge cases and handle them properly. "Happy path only" programming is **NOT** acceptable.
- This is a **SINGLE-USER OFFLINE APPLICATION.** Do not write or suggest code that optimizes for non-existent multi-user concurrency while sacrificing any aspect of the intended single-user experience.
- **DO NOT** use Node.js APIs if a native Bun API providing the same functionality, which should be used instead, specifically exists.
- All code requires proper TypeDoc documentation.
- Always run `npm run lint` after completing large batches of code changes.
# ULTIMATE SOURCES OF TRUTH:
The complete latest documentation for the llama-server CLI executable itself are in the `./llama-server-docs.md` file which can be found in the top-level workspace directory. Additionally, the hyperlinks listed below are all relevant.
Gemma 4 prompt formatting docs:
https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
Gemma 4 vision docs:
https://ai.google.dev/gemma/docs/capabilities/vision
Bun docs:
https://bun.com/docs
llama-cpp GGUF header constants (useful for determination of default publisher-recommended inference sampling settings from main LLM GGUF, i.e. general.sampling.xyz, and multimodal capabilities determination from companion MMPROJ GGUF when present, i.e. clip.has_vision_encoder or clip.has_audio_encoder):
https://github.com/ggml-org/llama.cpp/blob/master/gguf-py/gguf/constants.py