/**
 * @packageDocumentation
 * Global type declarations for Vite environment and CSS imports.
 */

/// <reference types="vite/client" />
declare module "*.css" {
  const content: any;
  export default content;
}
