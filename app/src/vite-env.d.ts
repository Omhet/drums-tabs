/// <reference types="vite/client" />

// .alphatex is our own extension, so Vite's built-in ?raw typings don't cover it.
declare module '*.alphatex?raw' {
  const content: string;
  export default content;
}
