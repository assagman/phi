# LiveFeed Implementation Plan - Epsilon Task #1736

## Overview
Convert ALL tool output sections in ToolExecutionComponent to use LiveFeed with maxLines=5. Apply markdown rendering and syntax highlighting to all content.

## Implementation Steps

### Phase 1: Update Constants and Imports

**File: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`**

1. **Update constants section** (lines ~20-30)
   ```typescript
   // BEFORE: Mixed values (10, 12, 20, 8, 6)
   const MAX_ERROR_LINES = 10;
   const MAX_CMD_LINES = 10;
   const MAX_ARG_LINES = 12;
   // ... etc
   
   // AFTER: Unified to 5
   const MAX_LIVEFEED_LINES = 5;
   ```

2. **Add imports**
   ```typescript
   import { LiveFeed } from "../../../tui/src/components/live-feed";
   import { Markdown } from "../../../tui/src/components/markdown";
   ```

### Phase 2: Convert formatArgsLines() Method

**Target: Lines ~XXX in tool-execution.ts**

1. **Create cached LiveFeed instance**
   ```typescript
   private argsFeed: LiveFeed | null = null;
   
   private getArgsFeed(): LiveFeed {
     if (!this.argsFeed) {
       this.argsFeed = new LiveFeed({ 
         maxLines: MAX_LIVEFEED_LINES,
         overflowText: (n) => `... ${n} more argument lines`
       });
     }
     return this.argsFeed;
   }
   ```

2. **Replace manual truncation logic**
   ```typescript
   // BEFORE: Manual slice and "..." append
   private formatArgsLines(): string[] {
     const json = JSON.stringify(this.execution.args, null, 2);
     const highlighted = this.theme.highlightCode(json, "json");
     return highlighted.length > MAX_ARG_LINES 
       ? [...highlighted.slice(0, MAX_ARG_LINES), "..."]
       : highlighted;
   }
   
   // AFTER: LiveFeed with incremental updates
   private formatArgsLines(): string[] {
     const feed = this.getArgsFeed();
     const json = JSON.stringify(this.execution.args, null, 2);
     const highlighted = this.theme.highlightCode(json, "json");
     
     feed.setItems([{ 
       id: "args", 
       text: highlighted.join('\n') 
     }]);
     
     return feed.render(this.width);
   }
   ```

### Phase 3: Convert errorLines() Method

**Target: Lines ~XXX in tool-execution.ts**

1. **Create cached LiveFeed instance**
   ```typescript
   private errorFeed: LiveFeed | null = null;
   
   private getErrorFeed(): LiveFeed {
     if (!this.errorFeed) {
       this.errorFeed = new LiveFeed({ 
         maxLines: MAX_LIVEFEED_LINES,
         overflowText: (n) => `... ${n} earlier error lines`
       });
     }
     return this.errorFeed;
   }
   ```

2. **Add syntax highlighting for errors**
   ```typescript
   private detectErrorLanguage(error: string): string | undefined {
     if (error.includes("TypeError:") || error.includes("SyntaxError:")) return "javascript";
     if (error.includes("Traceback") || error.includes("File \"")) return "python";
     if (error.includes("error:") && error.includes(".rs:")) return "rust";
     if (error.match(/^\s*at\s+/m)) return "javascript"; // Stack trace
     return undefined;
   }
   
   private errorLines(): string[] {
     const feed = this.getErrorFeed();
     const errorText = this.execution.error || "";
     const lang = this.detectErrorLanguage(errorText);
     
     const highlighted = lang 
       ? this.theme.highlightCode(errorText, lang)
       : errorText.split('\n').map(line => this.theme.fg("error", line));
     
     feed.setItems([{ 
       id: "error", 
       text: highlighted.join('\n') 
     }]);
     
     return feed.render(this.width);
   }
   ```

### Phase 4: Convert expandedOutputLines() Method

**Target: Lines ~XXX in tool-execution.ts**

1. **Create cached LiveFeed instance**
   ```typescript
   private expandedOutputFeed: LiveFeed | null = null;
   
   private getExpandedOutputFeed(): LiveFeed {
     if (!this.expandedOutputFeed) {
       this.expandedOutputFeed = new LiveFeed({ 
         maxLines: MAX_LIVEFEED_LINES,
         overflowText: (n) => `... ${n} more output lines`
       });
     }
     return this.expandedOutputFeed;
   }
   ```

2. **Add syntax highlighting based on tool type**
   ```typescript
   private detectOutputLanguage(tool: string, output: string): string | undefined {
     if (tool === "bash" || tool === "sh") {
       // Detect if output looks like structured data
       try {
         JSON.parse(output);
         return "json";
       } catch {}
       if (output.includes("<?xml")) return "xml";
       if (output.includes("<!DOCTYPE html")) return "html";
       return undefined; // Plain text for most bash output
     }
     if (tool === "read" && output.startsWith("```")) {
       const match = output.match(/^```(\w+)/);
       return match?.[1];
     }
     return undefined;
   }
   
   private expandedOutputLines(): string[] {
     const feed = this.getExpandedOutputFeed();
     const output = this.execution.output || "";
     const lang = this.detectOutputLanguage(this.execution.name, output);
     
     let processedOutput: string[];
     if (lang) {
       processedOutput = this.theme.highlightCode(output, lang);
     } else {
       // Apply markdown rendering for tool results that might contain markdown
       if (this.execution.name === "read" && this.isMarkdownLikeContent(output)) {
         const markdown = new Markdown();
         markdown.addContent(output);
         processedOutput = markdown.render(this.width);
       } else {
         processedOutput = output.split('\n').map(line => this.theme.fg("muted", line));
       }
     }
     
     feed.setItems([{ 
       id: "expanded-output", 
       text: processedOutput.join('\n') 
     }]);
     
     return feed.render(this.width);
   }
   
   private isMarkdownLikeContent(text: string): boolean {
     return /^#+\s|\|.*\||```|\*\*.*\*\*|\[.*\]\(/.test(text);
   }
   ```

### Phase 5: Convert formatParallelAgentSection() Method

**Target: Lines ~XXX in tool-execution.ts**

1. **Create cached LiveFeed instances**
   ```typescript
   private parallelToolsFeed: LiveFeed | null = null;
   private parallelStreamFeed: LiveFeed | null = null;
   
   private getParallelToolsFeed(): LiveFeed {
     if (!this.parallelToolsFeed) {
       this.parallelToolsFeed = new LiveFeed({ 
         maxLines: MAX_LIVEFEED_LINES,
         overflowText: (n) => `... ${n} more tools`
       });
     }
     return this.parallelToolsFeed;
   }
   
   private getParallelStreamFeed(): LiveFeed {
     if (!this.parallelStreamFeed) {
       this.parallelStreamFeed = new LiveFeed({ 
         maxLines: MAX_LIVEFEED_LINES,
         overflowText: (n) => `... ${n} more stream lines`
       });
     }
     return this.parallelStreamFeed;
   }
   ```

2. **Update method implementation**
   ```typescript
   private formatParallelAgentSection(/* params */): string[] {
     const lines: string[] = [];
     
     // Tools list with LiveFeed
     const toolsFeed = this.getParallelToolsFeed();
     const toolItems = tools.map((tool, idx) => ({
       id: `tool-${idx}`,
       text: `${this.theme.fg("dim", "▸")} ${tool.name}: ${JSON.stringify(tool.args)}`
     }));
     toolsFeed.setItems(toolItems);
     lines.push(...toolsFeed.render(this.width));
     
     // Stream preview with LiveFeed
     if (currentOutput) {
       const streamFeed = this.getParallelStreamFeed();
       const streamLines = currentOutput.split('\n')
         .map(line => this.theme.fg("thinkingText", line));
       
       streamFeed.setItems([{ 
         id: "stream", 
         text: streamLines.join('\n') 
       }]);
       lines.push(...streamFeed.render(this.width));
     }
     
     return lines;
   }
   ```

### Phase 6: Update streamingOutputLines() Method

**Target: Already uses LiveFeed, but needs consistency**

1. **Update maxLines to 5**
   ```typescript
   // BEFORE: maxLines: MAX_STREAMING_PREVIEW_LINES (8)
   // AFTER: maxLines: MAX_LIVEFEED_LINES (5)
   ```

2. **Add markdown rendering for streaming output**
   ```typescript
   private streamingOutputLines(): string[] {
     if (!this.streamFeed) {
       this.streamFeed = new LiveFeed({
         maxLines: MAX_LIVEFEED_LINES, // Changed from 8 to 5
         overflowText: (n) => `... ${n} earlier lines`
       });
     }
     
     const output = this.execution.output || "";
     let processedOutput: string;
     
     // Apply markdown for tools that might output markdown
     if (this.isMarkdownProducingTool(this.execution.name) && this.isMarkdownLikeContent(output)) {
       const markdown = new Markdown();
       markdown.addContent(output);
       processedOutput = markdown.render(this.width).join('\n');
     } else {
       // Apply syntax highlighting based on tool context
       const lang = this.detectOutputLanguage(this.execution.name, output);
       processedOutput = lang 
         ? this.theme.highlightCode(output, lang).join('\n')
         : output.split('\n').map(line => this.theme.fg("dim", line)).join('\n');
     }
     
     this.streamFeed.updateItem("output", processedOutput);
     return this.streamFeed.render(this.width);
   }
   
   private isMarkdownProducingTool(toolName: string): boolean {
     return ["subagent", "search", "agentsbox_execute"].includes(toolName);
   }
   ```

### Phase 7: Update bash-execution.ts

**File: `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`**

1. **Update constant**
   ```typescript
   // BEFORE: const PREVIEW_LINES = 20;
   // AFTER: const PREVIEW_LINES = 5;
   ```

2. **Enhance output styling**
   ```typescript
   // In the LiveFeed rendering logic, replace:
   // theme.fg("muted", line)
   // With context-aware styling:
   private styleOutputLine(line: string, command: string): string {
     // Detect structured output
     if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
       return this.theme.highlightCode(line, "json")[0] || this.theme.fg("muted", line);
     }
     if (line.includes("Error:") || line.includes("error:")) {
       return this.theme.fg("error", line);
     }
     if (line.includes("Warning:") || line.includes("warning:")) {
       return this.theme.fg("warning", line);
     }
     return this.theme.fg("muted", line);
   }
   ```

### Phase 8: Cache Invalidation

**Add to ToolExecutionComponent class**

```typescript
// Clear caches when execution changes
private clearFeeds(): void {
  this.argsFeed = null;
  this.errorFeed = null;
  this.expandedOutputFeed = null;
  this.parallelToolsFeed = null;
  this.parallelStreamFeed = null;
  // Keep this.streamFeed and this.subagentTaskFeed as they handle updates internally
}

// Call clearFeeds() when execution ID changes
```

### Phase 9: Testing Plan

1. **Unit Tests**
   - Test LiveFeed instances are created correctly
   - Test maxLines=5 enforcement across all methods
   - Test cache invalidation

2. **Integration Tests**
   - Test markdown rendering for different tool outputs
   - Test syntax highlighting detection logic
   - Test overflow text behavior

3. **Manual Testing**
   - Run tools with long outputs (>5 lines) to verify truncation
   - Test subagent outputs for markdown rendering
   - Test error outputs for proper highlighting

### Phase 10: Performance Considerations

1. **Memory Management**
   - LiveFeed instances cached per component
   - Clear caches on execution change
   - Markdown component reuse where possible

2. **Rendering Performance**
   - Pre-compute syntax highlighting
   - Avoid re-rendering unchanged LiveFeeds
   - Batch updates to LiveFeed items

## Files Modified

1. `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
   - Convert 4 sections to use LiveFeed
   - Add markdown rendering and syntax highlighting
   - Update constants and caching

2. `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`  
   - Change PREVIEW_LINES from 20 to 5
   - Enhance output styling

## Success Criteria

- ✅ All tool output sections use LiveFeed with maxLines=5
- ✅ Markdown rendering applied to relevant content
- ✅ Syntax highlighting based on tool context  
- ✅ Consistent overflow behavior across components
- ✅ No performance regressions
- ✅ Thread-safe implementation
- ✅ Cache management preserves existing patterns