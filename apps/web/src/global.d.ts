declare module '*.css' {
  const styles: { [className: string]: string }
  export default styles
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const ymaps3: any
