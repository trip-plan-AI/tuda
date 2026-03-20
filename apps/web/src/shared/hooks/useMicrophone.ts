'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseMicrophoneOptions {
  onTranscript?: (text: string) => void;
  onTranscriptUpdate?: (text: string) => void;
  language?: string;
  continuous?: boolean;
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

export function useMicrophone(options: UseMicrophoneOptions = {}): UseMicrophoneReturn {
  const { language = 'ru-RU', continuous = true } = options;

  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(true);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const recognitionRef = useRef<any>(null);
  // Храним колбэки и transcript в ref, чтобы не пересоздавать recognition при их изменении
  const transcriptRef = useRef(transcript);
  const onTranscriptRef = useRef(options.onTranscript);
  const onTranscriptUpdateRef = useRef(options.onTranscriptUpdate);

  transcriptRef.current = transcript;
  onTranscriptRef.current = options.onTranscript;
  onTranscriptUpdateRef.current = options.onTranscriptUpdate;

  useEffect(() => {
    const SpeechRecognition =
      typeof window !== 'undefined' &&
      ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);

    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const RecognitionAPI =
      (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;

    const recognition = new RecognitionAPI();
    recognition.continuous = continuous;
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
        const newTranscript = transcriptRef.current + final;
        transcriptRef.current = newTranscript;
        setTranscript(newTranscript);
        onTranscriptUpdateRef.current?.(newTranscript);
      }

      setInterimTranscript(interim);
    };

    recognition.onerror = (event: any) => {
      // 'aborted' — нормальная ситуация при вызове stop()/abort(), не логируем
      if (event.error !== 'aborted') {
        console.error('Ошибка распознавания:', event.error);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      if (transcriptRef.current) {
        onTranscriptRef.current?.(transcriptRef.current);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
    // Пересоздаём recognition только при смене языка или режима continuous
  }, [language, continuous]);

  const startListening = useCallback(async () => {
    if (recognitionRef.current && !isListening) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setMediaStream(stream);
      } catch (err) {
        console.error('Ошибка доступа к микрофону:', err);
      }
      recognitionRef.current.start();
    }
  }, [isListening]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
  }, [isListening, mediaStream]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = '';
    setTranscript('');
    setInterimTranscript('');
  }, []);

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
