import {
  AutoTokenizer,
  AutoProcessor,
  WhisperForConditionalGeneration,
  TextStreamer,
  full,
} from "@huggingface/transformers";

const MAX_NEW_TOKENS = 448; // Maximum tokens for Whisper architecture (~5 minutes of speech)

/**
 * This class uses the Singleton pattern to ensure that only one instance of the model is loaded.
 */
class AutomaticSpeechRecognitionPipeline {
  static model_id = "onnx-community/whisper-medium-ONNX";
  static tokenizer = null;
  static processor = null;
  static model = null;

  static async getInstance(progress_callback = null) {
    this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, {
      progress_callback,
    });
    this.processor ??= AutoProcessor.from_pretrained(this.model_id, {
      progress_callback,
    });

    this.model ??= WhisperForConditionalGeneration.from_pretrained(
      this.model_id,
      {
        dtype: {
          encoder_model: "fp32", // 'fp16' works too
          decoder_model_merged: "q4", // or 'fp32' ('fp16' is broken)
        },
        device: "webgpu",
        progress_callback,
      },
    );

    return Promise.all([this.tokenizer, this.processor, this.model]);
  }
}

let processing = false;
async function generate({ audio, language, isFinal }) {
  if (processing && !isFinal) {
    console.log("Worker: Already processing, ignoring non-final request. isFinal was:", isFinal);
    return;
  }
  
  // If we're processing and this is a final request, wait for current processing to finish
  if (processing && isFinal) {
    console.log("Worker: Waiting for current processing to finish before final processing");
    while (processing) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  processing = true;

  console.log("Worker: Starting generation, isFinal:", isFinal, "audio length:", audio.length);

  // Tell the main thread we are starting
  self.postMessage({ status: "start" });

  // Retrieve the text-generation pipeline.
  const [tokenizer, processor, model] =
    await AutomaticSpeechRecognitionPipeline.getInstance();

  let startTime;
  let numTokens = 0;
  let tps;
  const token_callback_function = () => {
    startTime ??= performance.now();

    if (numTokens++ > 0) {
      tps = (numTokens / (performance.now() - startTime)) * 1000;
    }
  };
  const callback_function = (output) => {
    self.postMessage({
      status: "update",
      output,
      tps,
      numTokens,
    });
  };

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function,
    token_callback_function,
  });

  const inputs = await processor(audio);

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS,
    language,
    streamer,
  });

  const decoded = tokenizer.batch_decode(outputs, {
    skip_special_tokens: true,
  });

  // Send the output back to the main thread
  console.log("Worker: Sending result, isFinal:", isFinal, "output:", decoded[0]);
  self.postMessage({
    status: "complete",
    output: decoded[0] || "",
    isFinal: isFinal || false,
  });
  processing = false;
}

async function load() {
  try {
    self.postMessage({
      status: "loading",
      data: "Loading model...",
    });

    // Load the pipeline and save it for future use.
    const [tokenizer, processor, model] =
      await AutomaticSpeechRecognitionPipeline.getInstance((x) => {
        // We also add a progress callback to the pipeline so that we can
        // track model loading.
        console.log("Loading progress:", x);
        self.postMessage(x);
      });

    self.postMessage({
      status: "loading",
      data: "Compiling shaders and warming up model...",
    });

    // Run model with dummy input to compile shaders
    await model.generate({
      input_features: full([1, 80, 3000], 0.0),
      max_new_tokens: 1,
    });
    self.postMessage({ status: "ready" });
  } catch (error) {
    console.error("Error loading model:", error);
    self.postMessage({
      status: "error",
      data: `Failed to load model: ${error.message}`,
    });
  }
}

// Listen for messages from the main thread
self.addEventListener("message", async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case "load":
      load();
      break;

    case "generate":
      generate(data);
      break;
  }
});