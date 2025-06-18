import {
  pipeline,
  full,
} from "@huggingface/transformers";

/**
 * This class uses the Singleton pattern to ensure that only one instance of the pipeline is loaded.
 */
class AutomaticSpeechRecognitionPipelineInstance {
  static model_id = "onnx-community/whisper-medium-ONNX";
  static transcriber = null;

  static async getInstance(progress_callback = null) {
    if (!this.transcriber) {
      this.transcriber = await pipeline('automatic-speech-recognition', this.model_id, {
        dtype: {
          encoder_model: "fp32", // 'fp16' works too
          decoder_model_merged: "q4", // or 'fp32' ('fp16' is broken)
        },
        device: "webgpu",
        progress_callback,
      });
    }
    return this.transcriber;
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

  // Retrieve the ASR pipeline
  const transcriber = await AutomaticSpeechRecognitionPipelineInstance.getInstance();

  let startTime;
  let numTokens = 0;
  let tps;
  
  const callback_function = (output) => {
    startTime ??= performance.now();
    numTokens++;
    if (numTokens > 1) {
      tps = (numTokens / (performance.now() - startTime)) * 1000;
    }
    
    self.postMessage({
      status: "update",
      output: Array.isArray(output) ? output.map(chunk => chunk.text).join(' ') : output,
      tps,
      numTokens,
    });
  };

  try {
    // Use pipeline with chunking for long-form transcription
    const options = {
      language,
      return_timestamps: true,
      callback_function: !isFinal ? callback_function : undefined, // Only use streaming for real-time
    };
    
    // Add chunking for final transcription (long-form)
    if (isFinal) {
      options.chunk_length_s = 30;
      options.stride_length_s = 5;
    }

    const output = await transcriber(audio, options);
    
    // Handle both string output and chunked output with timestamps
    let transcriptText = "";
    if (typeof output === 'string') {
      transcriptText = output;
    } else if (output.text) {
      transcriptText = output.text;
    } else if (Array.isArray(output)) {
      transcriptText = output.map(chunk => chunk.text).join(' ');
    }

    // Send the output back to the main thread
    console.log("Worker: Sending result, isFinal:", isFinal, "output:", transcriptText);
    self.postMessage({
      status: "complete",
      output: transcriptText || "",
      isFinal: isFinal || false,
    });
  } catch (error) {
    console.error("Error during transcription:", error);
    self.postMessage({
      status: "complete",
      output: "",
      isFinal: isFinal || false,
    });
  }
  
  processing = false;
}

async function load() {
  try {
    self.postMessage({
      status: "loading",
      data: "Loading model...",
    });

    // Load the pipeline and save it for future use.
    const transcriber = await AutomaticSpeechRecognitionPipelineInstance.getInstance((x) => {
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
    // Create a small dummy audio array (1 second of silence at 16kHz)
    const dummyAudio = new Float32Array(16000).fill(0);
    await transcriber(dummyAudio, { return_timestamps: false });
    
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