'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { useMicrophone, useAudioAnalyzer } from '@/shared/hooks';

interface MicrophoneButtonProps {
  onTranscriptUpdate?: (text: string) => void;
  onTranscript?: (text: string) => void;
  isSupported?: boolean;
  className?: string;
}

const EQUALIZER_BARS = 8; // Количество столбиков эквалайзера
const SILENCE_THRESHOLD = 5; // Порог громкости для определения тишины (0-100)
const SILENCE_TIMEOUT_MS = 5000; // 5 секунд тишины → авто-выключение

export function MicrophoneButton({
  onTranscriptUpdate,
  onTranscript,
  isSupported = true,
  className = '',
}: MicrophoneButtonProps) {
  const {
    isListening,
    startListening,
    stopListening,
    clearTranscript,
    isSupported: isMicSupported,
    mediaStream,
  } = useMicrophone({
    onTranscriptUpdate,
    onTranscript,
    language: 'ru-RU',
    continuous: true, // Непрерывное слушание
  });

  const { frequencies, volume, startAnalyzing, stopAnalyzing } = useAudioAnalyzer();

  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [equalizerBars, setEqualizerBars] = useState<number[]>(Array(EQUALIZER_BARS).fill(0));

  // Запускаем анализатор когда появляется mediaStream
  useEffect(() => {
    if (mediaStream && isListening) {
      startAnalyzing(mediaStream);
    } else {
      stopAnalyzing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaStream, isListening]);

  useEffect(() => {
    if (frequencies && isListening && frequencies.length > 0) {
      // Берём каждый N-й элемент из массива частот, чтобы получить нужное количество столбиков
      const step = Math.floor(frequencies.length / EQUALIZER_BARS);
      const bars = Array.from({ length: EQUALIZER_BARS }).map((_, i) => {
        const index = i * step;
        // Нормализуем значение (0-255) в диапазон (0-100)
        return ((frequencies[index] || 0) / 255) * 100;
      });
      setEqualizerBars(bars);
    } else {
      setEqualizerBars(Array(EQUALIZER_BARS).fill(0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frequencies, isListening]);

  // Авто-выключение микрофона после 5 секунд тишины
  useEffect(() => {
    if (!isListening) {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      return;
    }

    if (volume < SILENCE_THRESHOLD) {
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          silenceTimerRef.current = null;
          stopListening();
        }, SILENCE_TIMEOUT_MS);
      }
    } else {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, isListening]);

  // Очищаем таймер при размонтировании
  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
    };
  }, []);

  const handleMicClick = async () => {
    if (isListening) {
      stopListening();
    } else {
      clearTranscript();
      await startListening();
    }
  };

  const isActive = isMicSupported && isSupported;

  return (
    <button
      type="button"
      disabled={!isActive}
      onClick={handleMicClick}
      className={`relative flex items-center justify-center transition-all duration-300 ${
        isActive ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
      } ${className}`}
      title={
        !isActive
          ? 'Микрофон не поддерживается'
          : isListening
            ? 'Нажмите, чтобы остановить'
            : 'Нажмите, чтобы начать говорить'
      }
    >
      {/* Горизонтальный эквалайзер вместо микрофона при записи */}
      {isListening ? (
        <div className="relative z-10 flex items-end justify-center gap-0.5 h-6">
          {equalizerBars.map((height, i) => (
            <div
              key={i}
              className="w-1 bg-gradient-to-t from-brand-yellow to-amber-300 rounded-full transition-all duration-75 ease-out"
              style={{
                height: `${Math.max(4, (height / 100) * 24)}px`,
                opacity: 0.9,
              }}
            />
          ))}
        </div>
      ) : (
        /* Основная иконка микрофона */
        <div
          className={`relative z-10 p-3 rounded-full transition-all duration-300 ${
            isListening
              ? 'bg-brand-yellow shadow-lg shadow-brand-yellow/50'
              : 'bg-white/10 hover:bg-white/20'
          }`}
        >
          <Mic
            size={24}
            className={`transition-all duration-300 ${
              isListening ? 'text-white animate-pulse' : 'text-slate-300 hover:text-brand-yellow'
            }`}
          />
        </div>
      )}
    </button>
  );
}
