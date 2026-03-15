'use client';

import { useEffect, useRef, useState } from 'react';

interface UseMicrophoneOptions {
  onTranscript?: (text: string) => void;
  onTranscriptUpdate?: (text: string) => void;
  language?: string;
}

interface UseMicrophoneReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => void;
  stopListening: () => void;
  clearTranscript: () => void;
  isSupported: boolean;
  mediaStream: MediaStream | null;
}

export function useMicrophone(
  options: UseMicrophoneOptions = {}
): UseMicrophoneReturn {
  const {
    onTranscript,
    onTranscriptUpdate,
    language = 'ru-RU',
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(true);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // Проверяем поддержку Web Speech API
    const SpeechRecognition =
      typeof window !== 'undefined' &&
      ('webkitSpeechRecognition' in window ||
        'SpeechRecognition' in window);

    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const RecognitionAPI =
      (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;

    const recognition = new RecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          final += text + ' ';
        } else {
          interim += text;
        }
      }

      if (final) {
        const newTranscript = transcript + final;
        setTranscript(newTranscript);
        onTranscriptUpdate?.(newTranscript);
      }

      setInterimTranscript(interim);
    };

    recognition.onerror = (event: any) => {
      console.error('Ошибка распознавания:', event.error);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (transcript) {
        onTranscript?.(transcript);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
  }, [transcript, onTranscript, onTranscriptUpdate, language]);

  const startListening = async () => {
    if (recognitionRef.current && !isListening) {
      try {
        // Получаем аудиопоток для анализатора
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        setMediaStream(stream);
      } catch (err) {
        console.error('Ошибка доступа к микрофону:', err);
      }
      recognitionRef.current.start();
    }
  };

  const stopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
    }
    // Закрываем аудиопоток
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
  };

  const clearTranscript = () => {
    setTranscript('');
    setInterimTranscript('');
  };

  return {
    isListening,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    clearTranscript,
    isSupported,
    mediaStream,
  };
}
