import {
  normalizeProgramSceneChromaKey,
  type ProgramSceneChromaKeyConfig
} from '../../../../shared/program-scene'

type ChromaSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Не удалось создать GPU-шейдер хромакея.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Не удалось скомпилировать GPU-шейдер хромакея.'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function sourceSize(source: ChromaSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight }
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight }
  }
  return { width: source.width, height: source.height }
}

function hexToRgb(color: string): [number, number, number] {
  const normalized = normalizeProgramSceneChromaKey({ color }).color
  return [
    Number.parseInt(normalized.slice(1, 3), 16) / 255,
    Number.parseInt(normalized.slice(3, 5), 16) / 255,
    Number.parseInt(normalized.slice(5, 7), 16) / 255
  ]
}

export class ChromaKeyRenderer {
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly texture: WebGLTexture
  private readonly positionLocation: number
  private readonly keyColorLocation: WebGLUniformLocation
  private readonly toleranceLocation: WebGLUniformLocation
  private readonly softnessLocation: WebGLUniformLocation
  private readonly spillLocation: WebGLUniformLocation
  private readonly keyChannelLocation: WebGLUniformLocation

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    })
    if (!gl) throw new Error('GPU-хромакей недоступен.')
    this.gl = gl

    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_position * 0.5 + 0.5;
      }
    `)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D u_image;
      uniform vec3 u_keyColor;
      uniform float u_tolerance;
      uniform float u_softness;
      uniform float u_spill;
      uniform float u_keyChannel;
      varying vec2 v_texCoord;

      vec2 chroma(vec3 rgb) {
        return vec2(
          -0.168736 * rgb.r - 0.331264 * rgb.g + 0.5 * rgb.b,
           0.5 * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b
        );
      }

      void main() {
        vec4 sampleColor = texture2D(u_image, v_texCoord);
        float distanceFromKey = distance(chroma(sampleColor.rgb), chroma(u_keyColor));
        float alpha = smoothstep(u_tolerance, u_tolerance + u_softness, distanceFromKey);
        vec3 corrected = sampleColor.rgb;
        float keyedChannel;
        float otherChannels;
        if (u_keyChannel < 0.5) {
          keyedChannel = corrected.r;
          otherChannels = max(corrected.g, corrected.b);
          corrected.r = mix(corrected.r, min(corrected.r, otherChannels), u_spill * (1.0 - alpha));
        } else if (u_keyChannel < 1.5) {
          keyedChannel = corrected.g;
          otherChannels = max(corrected.r, corrected.b);
          corrected.g = mix(corrected.g, min(corrected.g, otherChannels), u_spill * (1.0 - alpha));
        } else {
          keyedChannel = corrected.b;
          otherChannels = max(corrected.r, corrected.g);
          corrected.b = mix(corrected.b, min(corrected.b, otherChannels), u_spill * (1.0 - alpha));
        }
        float spillEdge = smoothstep(0.0, 0.35, max(0.0, keyedChannel - otherChannels));
        corrected = mix(sampleColor.rgb, corrected, spillEdge);
        gl_FragColor = vec4(corrected, sampleColor.a * alpha);
      }
    `)
    const program = gl.createProgram()
    if (!program) throw new Error('Не удалось создать GPU-программу хромакея.')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Не удалось связать GPU-программу хромакея.'
      gl.deleteProgram(program)
      throw new Error(message)
    }
    this.program = program

    const buffer = gl.createBuffer()
    const texture = gl.createTexture()
    const keyColorLocation = gl.getUniformLocation(program, 'u_keyColor')
    const toleranceLocation = gl.getUniformLocation(program, 'u_tolerance')
    const softnessLocation = gl.getUniformLocation(program, 'u_softness')
    const spillLocation = gl.getUniformLocation(program, 'u_spill')
    const keyChannelLocation = gl.getUniformLocation(program, 'u_keyChannel')
    if (!buffer || !texture || !keyColorLocation || !toleranceLocation || !softnessLocation || !spillLocation || !keyChannelLocation) {
      gl.deleteBuffer(buffer)
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      throw new Error('Не удалось подготовить GPU-хромакей.')
    }
    this.buffer = buffer
    this.texture = texture
    this.positionLocation = gl.getAttribLocation(program, 'a_position')
    this.keyColorLocation = keyColorLocation
    this.toleranceLocation = toleranceLocation
    this.softnessLocation = softnessLocation
    this.spillLocation = spillLocation
    this.keyChannelLocation = keyChannelLocation

    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(this.positionLocation)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0)
    gl.clearColor(0, 0, 0, 0)
  }

  draw(source: ChromaSource, value: ProgramSceneChromaKeyConfig): boolean {
    const { width, height } = sourceSize(source)
    if (!width || !height) return false
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height

    const settings = normalizeProgramSceneChromaKey(value)
    const rgb = hexToRgb(settings.color)
    const keyChannel = rgb[1] >= rgb[0] && rgb[1] >= rgb[2] ? 1 : rgb[2] >= rgb[0] ? 2 : 0
    const gl = this.gl
    gl.viewport(0, 0, width, height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } catch {
      return false
    }
    gl.uniform3f(this.keyColorLocation, rgb[0], rgb[1], rgb[2])
    gl.uniform1f(this.toleranceLocation, 0.006 + settings.tolerance / 100 * 0.28)
    gl.uniform1f(this.softnessLocation, 0.004 + settings.softness / 100 * 0.2)
    gl.uniform1f(this.spillLocation, settings.spill / 100)
    gl.uniform1f(this.keyChannelLocation, keyChannel)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    return gl.getError() === gl.NO_ERROR
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.buffer)
    gl.deleteProgram(this.program)
  }
}

export function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('')}`
}
