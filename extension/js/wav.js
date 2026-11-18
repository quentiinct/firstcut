/* FirstCut - lecture d'un fichier WAV en enveloppe de cretes.
 *
 * Premiere exporte l'audio de la timeline en WAV ; on le relit en flux pour ne
 * jamais charger le fichier entier en memoire (une heure de stereo 48 kHz pese
 * pres de 700 Mo). Ne depend que de Node.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADWav = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function nodeRequire(name) {
    if (typeof window !== 'undefined') {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    }
    return require(name);
  }

  /**
   * Lit l'en-tete RIFF/WAVE.
   * @returns {Object} { format, channels, sampleRate, bits, blockAlign, dataOffset, dataSize }
   */
  function readHeader(filePath) {
    var fs = nodeRequire('fs');
    var Buffer = nodeRequire('buffer').Buffer;
    var fd = fs.openSync(filePath, 'r');
    try {
      var size = fs.fstatSync(fd).size;
      var head = Buffer.alloc(12);
      if (fs.readSync(fd, head, 0, 12, 0) < 12) throw new Error('fichier WAV trop court');
      var riff = head.toString('ascii', 0, 4);
      if ((riff !== 'RIFF' && riff !== 'RF64') || head.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error("ce n'est pas un fichier WAV");
      }

      var info = null;
      var pos = 12;
      var chunk = Buffer.alloc(8);
      while (pos + 8 <= size) {
        if (fs.readSync(fd, chunk, 0, 8, pos) < 8) break;
        var id = chunk.toString('ascii', 0, 4);
        var len = chunk.readUInt32LE(4);
        var body = pos + 8;

        if (id === 'fmt ') {
          var fmt = Buffer.alloc(Math.min(len, 40));
          fs.readSync(fd, fmt, 0, fmt.length, body);
          info = {
            format: fmt.readUInt16LE(0),
            channels: fmt.readUInt16LE(2),
            sampleRate: fmt.readUInt32LE(4),
            blockAlign: fmt.readUInt16LE(12),
            bits: fmt.readUInt16LE(14)
          };
          // WAVE_FORMAT_EXTENSIBLE : le vrai format est dans le sous-type.
          if (info.format === 0xfffe && fmt.length >= 26) info.format = fmt.readUInt16LE(24);
        } else if (id === 'data') {
          if (!info) throw new Error('WAV invalide : bloc data avant le bloc fmt');
          var dataSize = len;
          // Taille inconnue (export en flux) ou RF64 : on lit jusqu'au bout.
          if (len === 0 || len === 0xffffffff || body + len > size) dataSize = size - body;
          info.dataOffset = body;
          info.dataSize = dataSize - (dataSize % info.blockAlign);
          return info;
        }
        pos = body + len + (len % 2);
      }
      throw new Error('WAV invalide : bloc data introuvable');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Enveloppe de cretes d'un WAV.
   * @param {string} filePath
   * @param {number} hopSec    duree d'une tranche (0.005 = 5 ms)
   * @param {function} onProgress recoit un nombre entre 0 et 1
   * @returns {Promise<{hopSec, peaks: Float32Array, sampleRate, channels, durationSec}>}
   */
  function readEnvelope(filePath, hopSec, onProgress) {
    return new Promise(function (resolve, reject) {
      var fs = nodeRequire('fs');
      var Buffer = nodeRequire('buffer').Buffer;
      var info;
      try {
        info = readHeader(filePath);
      } catch (e) {
        reject(e);
        return;
      }

      var bytes = info.bits / 8;
      var isFloat = info.format === 3;
      if (!(info.format === 1 || isFloat) || [2, 3, 4].indexOf(bytes) < 0 || (isFloat && bytes !== 4)) {
        reject(new Error('format WAV non pris en charge (format ' + info.format + ', ' + info.bits + ' bits)'));
        return;
      }
      if (!info.channels || !info.sampleRate || info.blockAlign !== bytes * info.channels) {
        reject(new Error('en-tete WAV incoherent'));
        return;
      }

      var frames = Math.floor(info.dataSize / info.blockAlign);
      var hopFrames = Math.max(1, Math.round(info.sampleRate * hopSec));
      var realHop = hopFrames / info.sampleRate;
      var count = Math.ceil(frames / hopFrames);
      var peaks = new Float32Array(count);
      var channels = info.channels;
      var blockAlign = info.blockAlign;

      if (!frames) {
        resolve({ hopSec: realHop, peaks: peaks, sampleRate: info.sampleRate, channels: channels, durationSec: 0 });
        return;
      }

      var stream = fs.createReadStream(filePath, {
        start: info.dataOffset,
        end: info.dataOffset + info.dataSize - 1,
        highWaterMark: 1 << 20
      });

      var leftover = null;
      var frameIndex = 0; // trame courante dans le fichier
      var inHop = 0; // trames deja vues dans la tranche courante
      var hopIndex = 0;
      var hopMax = 0;
      var lastTick = 0;

      function sampleAbs(buf, off) {
        var v;
        if (isFloat) {
          v = buf.readFloatLE(off);
          return v < 0 ? -v : v;
        }
        if (bytes === 2) {
          v = buf.readInt16LE(off);
          return (v < 0 ? -v : v) / 32768;
        }
        if (bytes === 3) {
          v = buf.readIntLE(off, 3);
          return (v < 0 ? -v : v) / 8388608;
        }
        v = buf.readInt32LE(off);
        return (v < 0 ? -v : v) / 2147483648;
      }

      stream.on('data', function (chunk) {
        var buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
        var usable = buf.length - (buf.length % blockAlign);
        var off = 0;

        if (!isFloat && bytes === 2) {
          // Chemin rapide : c'est le format que Premiere exporte.
          while (off < usable) {
            for (var c = 0; c < channels; c++) {
              var s = buf.readInt16LE(off);
              if (s < 0) s = -s;
              if (s > hopMax) hopMax = s;
              off += 2;
            }
            if (++inHop === hopFrames) {
              peaks[hopIndex++] = hopMax / 32768;
              hopMax = 0;
              inHop = 0;
            }
          }
        } else {
          while (off < usable) {
            for (var c2 = 0; c2 < channels; c2++) {
              var a = sampleAbs(buf, off);
              if (a > hopMax) hopMax = a;
              off += bytes;
            }
            if (++inHop === hopFrames) {
              peaks[hopIndex++] = hopMax;
              hopMax = 0;
              inHop = 0;
            }
          }
        }

        frameIndex += usable / blockAlign;
        leftover = usable < buf.length ? buf.slice(usable) : null;

        if (onProgress) {
          var now = Date.now();
          if (now - lastTick > 100) {
            lastTick = now;
            onProgress(Math.min(1, frameIndex / frames));
          }
        }
      });

      stream.on('error', reject);

      stream.on('end', function () {
        if (inHop > 0 && hopIndex < count) {
          peaks[hopIndex++] = !isFloat && bytes === 2 ? hopMax / 32768 : hopMax;
        }
        if (onProgress) onProgress(1);
        resolve({
          hopSec: realHop,
          peaks: hopIndex === count ? peaks : peaks.subarray(0, hopIndex),
          sampleRate: info.sampleRate,
          channels: channels,
          durationSec: frames / info.sampleRate
        });
      });
    });
  }

  /**
   * Extrait [startSec, startSec + durSec] d'un WAV en mono 16 kHz 16 bits,
   * le format attendu par whisper. Chaque echantillon de sortie est la moyenne
   * des echantillons source qu'il couvre (filtre simple contre le repliement).
   * @returns {Promise<{ durationSec }>}
   */
  function to16kMono(src, dst, startSec, durSec, onProgress) {
    return new Promise(function (resolve, reject) {
      var fs = nodeRequire('fs');
      var Buffer = nodeRequire('buffer').Buffer;
      var info;
      try {
        info = readHeader(src);
      } catch (e) {
        reject(e);
        return;
      }
      var bytes = info.bits / 8;
      var isFloat = info.format === 3;
      if (!(info.format === 1 || isFloat) || [2, 3, 4].indexOf(bytes) < 0) {
        reject(new Error('format WAV non pris en charge'));
        return;
      }
      var OUT = 16000;
      var rate = info.sampleRate;
      var ch = info.channels;
      var block = info.blockAlign;
      var totalFrames = Math.floor(info.dataSize / block);
      var f0 = Math.max(0, Math.min(totalFrames, Math.round((startSec || 0) * rate)));
      var f1 = durSec > 0 ? Math.min(totalFrames, f0 + Math.round(durSec * rate)) : totalFrames;
      var step = rate / OUT;
      var outCount = Math.floor((f1 - f0) / step);
      var out = Buffer.alloc(44 + outCount * 2);
      out.write('RIFF', 0, 'ascii');
      out.writeUInt32LE(36 + outCount * 2, 4);
      out.write('WAVE', 8, 'ascii');
      out.write('fmt ', 12, 'ascii');
      out.writeUInt32LE(16, 16);
      out.writeUInt16LE(1, 20);
      out.writeUInt16LE(1, 22);
      out.writeUInt32LE(OUT, 24);
      out.writeUInt32LE(OUT * 2, 28);
      out.writeUInt16LE(2, 32);
      out.writeUInt16LE(16, 34);
      out.write('data', 36, 'ascii');
      out.writeUInt32LE(outCount * 2, 40);

      if (f1 <= f0) {
        fs.writeFileSync(dst, out);
        resolve({ durationSec: 0 });
        return;
      }

      function sample(buf, off) {
        if (isFloat) return buf.readFloatLE(off);
        if (bytes === 2) return buf.readInt16LE(off) / 32768;
        if (bytes === 3) return buf.readIntLE(off, 3) / 8388608;
        return buf.readInt32LE(off) / 2147483648;
      }

      var stream = fs.createReadStream(src, {
        start: info.dataOffset + f0 * block,
        end: info.dataOffset + f1 * block - 1,
        highWaterMark: 1 << 20
      });
      var leftover = null;
      var frame = 0; // trames source lues depuis f0
      var k = 0; // echantillon de sortie en cours
      var acc = 0;
      var n = 0;
      var lastTick = 0;

      function flush() {
        if (k >= outCount) return;
        var v = n ? acc / n : 0;
        if (v > 1) v = 1;
        if (v < -1) v = -1;
        out.writeInt16LE(Math.round(v * 32767), 44 + k * 2);
        k++;
        acc = 0;
        n = 0;
      }

      stream.on('data', function (chunk) {
        var buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
        var usable = buf.length - (buf.length % block);
        for (var off = 0; off < usable; off += block) {
          var m = 0;
          for (var c = 0; c < ch; c++) m += sample(buf, off + c * bytes);
          acc += m / ch;
          n++;
          frame++;
          if (frame >= (k + 1) * step) flush();
        }
        leftover = usable < buf.length ? buf.slice(usable) : null;
        if (onProgress && Date.now() - lastTick > 100) {
          lastTick = Date.now();
          onProgress(frame / (f1 - f0));
        }
      });
      stream.on('error', reject);
      stream.on('end', function () {
        while (k < outCount) flush();
        try {
          fs.writeFileSync(dst, out);
        } catch (e) {
          reject(e);
          return;
        }
        if (onProgress) onProgress(1);
        resolve({ durationSec: outCount / OUT });
      });
    });
  }

  return { readHeader: readHeader, readEnvelope: readEnvelope, to16kMono: to16kMono };
});
