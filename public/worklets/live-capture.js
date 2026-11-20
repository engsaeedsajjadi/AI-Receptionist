// Gemini Live lab: hands raw microphone blocks to the page (served same-origin,
// because the Content-Security-Policy does not allow blob: scripts).
class LiveCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("live-capture", LiveCapture);
