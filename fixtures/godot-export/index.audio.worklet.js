// Test stand-in for Godot's audio worklet (fixture only).
class GodotProcessor extends AudioWorkletProcessor { process() { return true } }
registerProcessor('godot-processor', GodotProcessor)
