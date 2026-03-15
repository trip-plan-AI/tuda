'use client';

import { useEffect, useState } from 'react';
import { Mic } from 'lucide-react';
import { useMicrophone, useAudioAnalyzer } from '@/shared/hooks';

interface MicrophoneButtonProps {
  onTranscriptUpdate?: (text: string) => void;
  onTranscript?: (text: string) => void;
  isSupported?: boolean;
  className?: string;
}

const EQUALIZER_BARS = 8; // Количество столбиков эквалайзера

export function MicrophoneButton({
  onTranscriptUpdate,
  onTranscript,
  isSupported = true,
  className = '',
}: MicrophoneButtonProps) {
  const {
    isListening,
    transcript,
    startListening,
    stopListening,
    clearTranscript,
    isSupported: isMicSupported,
    mediaStream,
  } = useMicrophone({
    onTranscriptUpdate,
    onTranscript,
    language: 'ru-RU',
  });

  const { frequencies, volume } = useAudioAnalyzer();

  const [equalizerBars, setEqualizerBars] = useState<number[]>(Array(EQUALIZER_BARS).fill(0));

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
  }, [frequencies, isListening]);

  const handleMicClick = async () => {
    if (isListening) {
      stopListening();
    } else {
      clearTranscript();
      // Запрашиваем микрофон перед началом прослушивания
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        // Закрываем поток после получения доступа (он будет переоткрыт в useMicrophone)
        stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        console.error('Микрофон недоступен:', err);
        return;
      }
      startListening();
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
        <div className="relative z-10 flex items-center gap-1 h-8 px-2">
          {equalizerBars.map((height, i) => (
            <div
              key={i}
              className="w-1.5 bg-gradient-to-t from-brand-yellow to-amber-300 rounded-full transition-all duration-100 ease-out"
              style={{
                height: `${Math.max(12, (height / 100) * 32)}px`,
                opacity: 1,
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

      {/* Индикатор громкости */}
      {isListening && (
        <div className="absolute -bottom-2 -right-2 flex flex-col gap-0.5">
          {/* Уровень громкости в виде кружочков */}
          {[0, 33, 66].map((threshold) => (
            <div
              key={threshold}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-150 ${
                volume > threshold
                  ? 'bg-brand-yellow shadow-lg shadow-brand-yellow/50'
                  : 'bg-slate-400/30'
              }`}
            />
          ))}
        </div>
      )}
    </button>
  );
}
