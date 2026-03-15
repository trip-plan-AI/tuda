'use client';

import { useEffect, useState } from 'react';

interface UseStreamingTextOptions {
  speed?: number; // миллисекунды между буквами
}

export function useStreamingText(
  fullText: string,
  options: UseStreamingTextOptions = {}
) {
  const { speed = 20 } = options;
  const [displayText, setDisplayText] = useState('');

  useEffect(() => {
    if (!fullText) {
      setDisplayText('');
      return;
    }

    let currentIndex = 0;
    setDisplayText('');

    const interval = setInterval(() => {
      if (currentIndex < fullText.length) {
        setDisplayText(fullText.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(interval);
      }
    }, speed);

    return () => clearInterval(interval);
  }, [fullText, speed]);

  return displayText;
}
