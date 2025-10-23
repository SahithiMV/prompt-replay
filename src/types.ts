export type PromptEvent = {
    id: string;
    timestamp: number;
    prompt: string;
    responsePreview?: string;
    repoRoot: string;
    beforeRef?: string;  // best-effort: HEAD sha or pseudo
    afterRef?: string;   // typically "WORKING"
    filesChanged: string[];
    diffUris: { path: string; left?: string; right?: string }[];
    tags?: string[];
  };
  
  export type SessionState = {
    active: boolean;
    repoRoot?: string;
    lastCheckpointSha?: string;
  };
  