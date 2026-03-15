'use client';

import { useEffect, useRef, useState } from 'react';

interface UseAudioAnalyzerReturn {
  frequencies: number[] | null;
  volume: number; // 0-100
  isAnalyzing: boolean;
  startAnalyzing: (stream: MediaStream) => void;
  stopAnalyzing: () => void;
}

export function useAudioAnalyzer(): UseAudioAnalyzerReturn {
  const [frequencies, setFrequencies] = useState<number[] | null>(null);
  const [volume, setVolume] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  const startAnalyzing = (stream: MediaStream) => {
    try {
      micStreamRef.current = stream;

      const audioContext =
        audioContextRef.current ||
        new (window.AudioContext || (window as any).webkitAudioContext)();

      audioContextRef.current = audioContext;

      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 256; // 128 частотных полос для 4K экранов

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyzer);

      analyzerRef.current = analyzer;

      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      dataArrayRef.current = dataArray;

      setIsAnalyzing(true);

      const analyze = () => {
        if (analyzerRef.current && dataArrayRef.current) {
          const data = dataArrayRef.current as Uint8Array;
          // @ts-ignore - Type compatibility issue with Uint8Array
          analyzerRef.current.getByteFrequencyData(data);

          // Вычислить громкость как среднее значение амплитуды
          const sum = data.reduce((a, b) => a + b, 0);
          const average = sum / data.length;
          const normalizedVolume = Math.min(100, (average / 255) * 100 * 2);

          setFrequencies(Array.from(data));
          setVolume(normalizedVolume);
        }

        animationFrameRef.current = requestAnimationFrame(analyze);
      };

      analyze();
    } catch (err) {
      console.error('Ошибка при инициализации Audio Analyzer:', err);
    }
  };

  const stopAnalyzing = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    setIsAnalyzing(false);
    setFrequencies(null);
    setVolume(0);
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return {
    frequencies,
    volume,
    isAnalyzing,
    startAnalyzing,
    stopAnalyzing,
  };
}
