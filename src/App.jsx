import { useEffect, useState, useRef } from "react";

import { AudioVisualizer } from "./components/AudioVisualizer";
import Progress from "./components/Progress";

const IS_WEBGPU_AVAILABLE = !!navigator.gpu;

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30; // seconds
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;

function App() {
  // Create a reference to the worker object.
  const worker = useRef(null);

  const recorderRef = useRef(null);

  // Model loading and progress
  const [status, setStatus] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [progressItems, setProgressItems] = useState([]);

  // Inputs and outputs
  const [realtimeText, setRealtimeText] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [tps, setTps] = useState(null);
  const [debouncedTps, setDebouncedTps] = useState(null);

  // Processing
  const [recording, setRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [chunks, setChunks] = useState([]);
  const fullRecordingRef = useRef([]);
  const [stream, setStream] = useState(null);
  const audioContextRef = useRef(null);
  const [recordingStartTime, setRecordingStartTime] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [allowRealtimeProcessing, setAllowRealtimeProcessing] = useState(true);
  const [processingFinalTranscript, setProcessingFinalTranscript] = useState(false);
  const textareaRef = useRef(null);

  // We use the `useEffect` hook to setup the worker as soon as the `App` component is mounted.
  useEffect(() => {
    if (!worker.current) {
      // Create the worker if it does not yet exist.
      worker.current = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
    }

    // Create a callback function for messages from the worker thread.
    const onMessageReceived = (e) => {
      switch (e.data.status) {
        case "loading":
          // Model file start load: add a new progress item to the list.
          setStatus("loading");
          setLoadingMessage(e.data.data);
          break;

        case "initiate":
          setProgressItems((prev) => [...prev, e.data]);
          break;

        case "progress":
          // Model file progress: update one of the progress items.
          setProgressItems((prev) =>
            prev.map((item) => {
              if (item.file === e.data.file) {
                return { ...item, ...e.data };
              }
              return item;
            }),
          );
          break;

        case "done":
          // Model file loaded: remove the progress item from the list.
          setProgressItems((prev) =>
            prev.filter((item) => item.file !== e.data.file),
          );
          break;

        case "ready":
          // Pipeline ready: the worker is ready to accept messages.
          setStatus("ready");
          break;

        case "start":
          {
            // Start generation
            setIsProcessing(true);

            // Request new data from the recorder if we're recording
            if (recorderRef.current && recorderRef.current.state === "recording") {
              recorderRef.current.requestData();
            }
          }
          break;

        case "update":
          {
            // Generation update: update the output text.
            const { tps } = e.data;
            setTps(tps);
          }
          break;

        case "complete":
          // Generation complete: re-enable the "Generate" button
          setIsProcessing(false);
          if (e.data.isFinal) {
            // This is the final transcription
            console.log("Received final transcript:", e.data.output);
            setProcessingFinalTranscript(false); // Final processing complete
            const cleanedOutput = e.data.output.replace(/\[BLANK_AUDIO\]/g, '').trim();
            if (cleanedOutput) {
              console.log("Adding to final transcript:", cleanedOutput);
              setFinalTranscript(prev => prev + (prev ? " " : "") + cleanedOutput);
              
              // Focus textarea after update
              setTimeout(() => {
                if (textareaRef.current) {
                  textareaRef.current.focus();
                }
              }, 0);
            }
            setRealtimeText("");
          } else {
            // Real-time transcription complete, update the text
            const cleanedOutput = e.data.output.replace(/\[BLANK_AUDIO\]/g, '').trim();
            setRealtimeText(cleanedOutput);
          }
          break;
      }
    };

    // Attach the callback function as an event listener.
    worker.current.addEventListener("message", onMessageReceived);

    // Define a cleanup function for when the component is unmounted.
    return () => {
      worker.current.removeEventListener("message", onMessageReceived);
    };
  }, []);

  useEffect(() => {
    if (recorderRef.current) return; // Already set

    if (navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          setStream(stream);

          recorderRef.current = new MediaRecorder(stream);
          audioContextRef.current = new AudioContext({
            sampleRate: WHISPER_SAMPLING_RATE,
          });

          recorderRef.current.onstart = () => {
            setRecording(true);
            setAllowRealtimeProcessing(true);
            setRecordingStartTime(Date.now());
            setElapsedTime(0);
            setChunks([]);
            fullRecordingRef.current = [];
            setRealtimeText("");
            // Small delay to ensure recording has actually started
            setTimeout(() => {
              if (recorderRef.current && recorderRef.current.state === "recording") {
                recorderRef.current.requestData();
              }
            }, 100);
          };
          recorderRef.current.ondataavailable = (e) => {
            if (e.data.size > 0) {
              setChunks((prev) => [...prev, e.data]);
              fullRecordingRef.current = [...fullRecordingRef.current, e.data];
            } else {
              // Empty chunk received, so we request new data after a short timeout
              setTimeout(() => {
                if (recorderRef.current && recorderRef.current.state === "recording") {
                  recorderRef.current.requestData();
                }
              }, 25);
            }
          };

          recorderRef.current.onstop = () => {
            setRecording(false);
            setAllowRealtimeProcessing(false); // Stop real-time processing immediately
            setRecordingStartTime(null);
            setElapsedTime(0);
            setRealtimeText("");
            
            // Process the full recording for final transcription
            if (fullRecordingRef.current.length > 0) {
              console.log("Processing final recording with", fullRecordingRef.current.length, "chunks");
              setProcessingFinalTranscript(true); // Start final processing
              const mimeType = recorderRef.current.mimeType;
              const blob = new Blob(fullRecordingRef.current, { type: mimeType });
              
              const fileReader = new FileReader();
              
              fileReader.onloadend = async () => {
                try {
                  const arrayBuffer = fileReader.result;
                  const decoded = await audioContextRef.current.decodeAudioData(arrayBuffer.slice(0));
                  const audio = decoded.getChannelData(0);
                  
                  console.log("Sending final audio for processing, length:", audio.length);
                  worker.current.postMessage({
                    type: "generate",
                    data: { audio, language: "en", isFinal: true },
                  });
                } catch (error) {
                  console.error("Error processing final audio:", error);
                  setProcessingFinalTranscript(false); // Reset on error
                }
              };
              fileReader.readAsArrayBuffer(blob);
            } else {
              console.log("No recording chunks to process for final transcript");
            }
          };
        })
        .catch((err) => console.error("The following error occurred: ", err));
    } else {
      console.error("getUserMedia not supported on your browser!");
    }

    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!recorderRef.current) return;
    if (!recording) return;
    if (!allowRealtimeProcessing) return; // Don't process if real-time processing is disabled
    if (isProcessing) return;
    if (status !== "ready") return;

    if (chunks.length > 0) {
      // Generate from data
      const blob = new Blob(chunks, { type: recorderRef.current.mimeType });

      const fileReader = new FileReader();

      fileReader.onloadend = async () => {
        const arrayBuffer = fileReader.result;
        const decoded =
          await audioContextRef.current.decodeAudioData(arrayBuffer);
        let audio = decoded.getChannelData(0);
        if (audio.length > MAX_SAMPLES) {
          // Get last MAX_SAMPLES
          audio = audio.slice(-MAX_SAMPLES);
        }

        worker.current.postMessage({
          type: "generate",
          data: { audio, language: "en", isFinal: false },
        });
      };
      fileReader.readAsArrayBuffer(blob);
    } else {
      recorderRef.current?.requestData();
    }
  }, [status, recording, isProcessing, chunks, allowRealtimeProcessing]);

  // Debounce TPS updates to prevent flickering
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTps(tps);
    }, 200); // Reduced from 500ms to 200ms for faster initial display

    return () => clearTimeout(timer);
  }, [tps]);

  // Update elapsed time while recording
  useEffect(() => {
    let interval;
    if (recording && recordingStartTime) {
      interval = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - recordingStartTime) / 1000));
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [recording, recordingStartTime]);

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
    } else {
      // Ensure audio context is resumed (required by browsers)
      if (audioContextRef.current && audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }
      
      // Ensure recorder is in the right state before starting
      if (recorderRef.current && recorderRef.current.state === "inactive") {
        recorderRef.current.start();
      } else if (recorderRef.current) {
        console.log("Recorder state:", recorderRef.current.state);
      }
    }
  };

  const copyTranscript = () => {
    if (finalTranscript) {
      navigator.clipboard.writeText(finalTranscript);
    }
  };

  const clearTranscript = () => {
    setFinalTranscript("");
  };

  const formatElapsedTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return IS_WEBGPU_AVAILABLE ? (
    <div className="min-h-screen bg-[#0f1419] text-[#e7e9ea] flex flex-col">
      <div className="max-w-7xl mx-auto w-full px-5 py-5 flex flex-col min-h-screen">
        {/* Header */}
        <div className="flex justify-between items-center mb-6 pb-5 border-b border-[#2f3336]">
          <h1 className="text-2xl font-semibold text-white">Transcribe Locally</h1>
          <div className="flex items-center gap-2 px-4 py-2 bg-white/5 rounded-full text-sm">
            <div className={`w-2 h-2 rounded-full transition-all duration-300 ${
              processingFinalTranscript ? "bg-[#efa847] animate-pulse" :
              recording ? "bg-[#B11000] animate-pulse" :
              status === "ready" ? "bg-[#479faf]" : 
              status === "loading" || status === null ? "bg-[#efa847]" :
              "bg-[#71767b]"
            }`}></div>
            <span>
              {processingFinalTranscript ? "Processing" :
               recording ? "Recording" :
               status === "ready" ? "Ready" : 
               status === "loading" ? "Loading" : 
               "Initializing"}
            </span>
          </div>
        </div>

        {status === null && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-semibold mb-4 text-white">OpenAI Whisper</h2>
              <p className="mb-6 text-[#71767b] max-w-md">
                Running locally in your browser with WebGPU.
                <br />
                Click below to load the model (~500 MB).
              </p>
              <button
                className="px-8 py-4 bg-[#479faf] text-white rounded-full font-medium hover:bg-[#3a8a98] transition-all duration-200 hover:-translate-y-0.5"
                onClick={() => {
                  worker.current.postMessage({ type: "load" });
                  setStatus("loading");
                }}
              >
                Load Model
              </button>
            </div>
          </div>
        )}

        {status === "loading" && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center w-full max-w-md">
              <p className="mb-6 text-lg">{loadingMessage}</p>
              {progressItems.map(({ file, progress, total }, i) => (
                <Progress
                  key={i}
                  text={file}
                  percentage={progress}
                  total={total}
                />
              ))}
            </div>
          </div>
        )}

        {status === "ready" && (
          <>
            {/* Controls */}
            <div className="flex gap-4 mb-6 items-center">
              <button
                className={`flex items-center gap-2 px-8 py-3 rounded-full font-medium transition-all duration-200 hover:-translate-y-0.5 ${
                  processingFinalTranscript
                    ? "bg-[#71767b] text-white cursor-not-allowed"
                    : recording 
                      ? "bg-[#efa847] text-white hover:bg-[#d8933a]" 
                      : "bg-[#479faf] text-white hover:bg-[#3a8a98]"
                }`}
                onClick={toggleRecording}
                disabled={processingFinalTranscript}
              >
                {processingFinalTranscript ? (
                  <>
                    <span className="text-xl">⏳</span>
                    Processing...
                  </>
                ) : recording ? (
                  <>
                    <span className="text-xl">■</span>
                    Stop Recording
                  </>
                ) : (
                  <>
                    <span className="text-xl">▶</span>
                    Start Recording
                  </>
                )}
              </button>
              {recording && (
                <div className="px-4 py-2 bg-white/5 rounded-full text-sm font-mono">
                  {formatElapsedTime(elapsedTime)}
                </div>
              )}
            </div>

            {/* Main Content */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">
              {/* Left Panel - Live Transcript (1/3) */}
              <div className="lg:col-span-1 bg-[#16181c] border border-[#2f3336] rounded-2xl p-6 flex flex-col h-[500px]">
                <div className="flex justify-between items-center mb-4 pb-4 border-b border-[#2f3336]">
                  <div>
                    <h2 className="text-lg font-semibold">Live Preview</h2>
                    <p className="text-sm text-[#71767b]">Real-time sampling</p>
                  </div>
                </div>

                {/* Waveform */}
                <div className="h-16 bg-black/30 rounded-xl flex items-center justify-center overflow-hidden mb-4">
                  <AudioVisualizer className="w-full h-full" stream={stream} />
                </div>
                
                <div className="flex-1 bg-black/30 rounded-xl p-4 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-white/5 scrollbar-thumb-white/10 hover:scrollbar-thumb-white/15">
                  <p className="leading-relaxed text-sm break-words whitespace-pre-wrap">
                    {realtimeText || (recording ? "Listening..." : "Click Start Recording to begin transcribing...")}
                  </p>
                  {recording && (
                    <div className="mt-3 pt-3 border-t border-white/10 text-xs text-[#71767b] transition-all duration-300">
                      {debouncedTps && `${debouncedTps.toFixed(1)} tokens/sec`}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel - Complete Transcript (2/3) */}
              <div className="lg:col-span-2 bg-[#16181c] border border-[#2f3336] rounded-2xl p-6 flex flex-col h-[500px]">
                <div className="flex justify-between items-center mb-4 pb-4 border-b border-[#2f3336]">
                  <div>
                    <h2 className="text-lg font-semibold">Complete Transcript</h2>
                    <p className="text-sm text-[#71767b]">Processed from recorded audio</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="px-4 py-2 bg-white/10 text-[#e7e9ea] border border-white/20 rounded-lg text-sm font-medium hover:bg-white/15 transition-colors"
                      onClick={clearTranscript}
                      disabled={!finalTranscript}
                    >
                      Clear
                    </button>
                    <button
                      className="px-4 py-2 bg-white/10 text-[#e7e9ea] border border-white/20 rounded-lg text-sm font-medium hover:bg-white/15 transition-colors"
                      onClick={copyTranscript}
                      disabled={!finalTranscript}
                    >
                      Copy Text
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 bg-black/30 rounded-xl p-4 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-white/5 scrollbar-thumb-white/10 hover:scrollbar-thumb-white/15">
                  <textarea
                    ref={textareaRef}
                    className={`w-full h-full bg-transparent border-none outline-none resize-none leading-relaxed text-[#e7e9ea] placeholder-[#71767b] transition-opacity duration-200 ${
                      recording || processingFinalTranscript 
                        ? 'opacity-50 cursor-not-allowed' 
                        : 'cursor-text'
                    }`}
                    value={finalTranscript}
                    onChange={(e) => setFinalTranscript(e.target.value)}
                    disabled={recording || processingFinalTranscript}
                    placeholder="Your complete transcripts will appear here after you stop recording."
                    style={{ fontFamily: 'inherit' }}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  ) : (
    <div className="h-screen bg-[#0f1419] flex items-center justify-center text-white text-2xl font-semibold text-center">
      WebGPU is not supported
      <br />
      by this browser :(
    </div>
  );
}

export default App;