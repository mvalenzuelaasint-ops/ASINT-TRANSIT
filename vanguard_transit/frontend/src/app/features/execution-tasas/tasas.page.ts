import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

const RENDER_BACKEND = 'https://asint-transit.onrender.com';

function longRunUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  return isLocal ? path : `${RENDER_BACKEND}${path}`;
}

interface OutputFile {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
  readonly ext: string;
}

interface RunResponse {
  readonly runId: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly inputFile?: string;
  readonly files?: OutputFile[];
  readonly stdoutTail?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly detail?: string;
}

@Component({
  selector: 'app-execution-tasas',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-4 py-6 md:px-8 md:py-8">
      <header class="mb-6">
        <p class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">Ejecución operacional</p>
        <h1 class="mt-1 font-headline text-2xl font-bold uppercase tracking-tight text-on-surface md:text-3xl">Tasas de ocupación</h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Cargue el archivo de contadores de pasajeros y calcularemos las tasas de ocupación promedio por servicio, tipo de día y período.
          Al finalizar, obtendrá reportes Excel agrupados por línea de transporte.
        </p>
      </header>

      <!-- Carga de archivo -->
      <article class="card-accent-secondary mb-6">
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-center gap-4">
              <span class="material-symbols-outlined text-3xl text-secondary">upload_file</span>
              <div>
                <h3 class="section-title">Archivo de contadores</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Formato: TXT delimitado por punto y coma (;) con datos de pasajeros subidos/bajados por puerta.</p>
                @if (inputFile()) {
                  <p class="mt-2 font-mono text-xs text-on-surface">
                    {{ inputFile()!.name }}
                    <span class="text-on-surface-variant">({{ formatBytes(inputFile()!.size) }})</span>
                  </p>
                }
              </div>
            </div>

            <div class="flex items-center gap-2">
              <input #fileInput class="hidden" type="file" accept=".txt" (change)="onFileSelected($event)">
              <button class="btn-secondary" type="button" [disabled]="running()" (click)="fileInput.click()">
                <span class="material-symbols-outlined text-sm">folder_open</span>
                {{ inputFile() ? 'Cambiar' : 'Elegir archivo' }}
              </button>
              <button class="btn-primary" type="button" [disabled]="!canRun()" (click)="runTasas()">
                @if (running()) {
                  <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Procesando...
                } @else {
                  <span class="material-symbols-outlined text-sm">play_arrow</span>
                  Procesar
                }
              </button>
            </div>
          </div>
        </div>
      </article>

      <!-- Error -->
      @if (errorMessage()) {
        <article class="card-accent-error mb-6">
          <div class="flex items-start gap-3">
            <span class="material-symbols-outlined text-2xl text-error">error</span>
            <div class="min-w-0 flex-1">
              <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-error">Error</h3>
              <p class="mt-1 text-xs text-on-surface">{{ errorMessage() }}</p>
              @if (errorDetail()) {
                <pre class="mt-3 max-h-64 overflow-auto rounded bg-surface-container p-3 font-mono text-[10px] leading-relaxed text-on-surface-variant">{{ errorDetail() }}</pre>
              }
            </div>
          </div>
        </article>
      }

      <!-- Resultado -->
      @if (result(); as r) {
        @if (r.success) {
          <article class="card-accent-primary mb-6">
            <div class="flex items-start gap-3">
              <span class="material-symbols-outlined text-2xl text-primary">check_circle</span>
              <div class="min-w-0 flex-1">
                <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-primary">Ejecución completada</h3>
                <p class="mt-1 text-xs text-on-surface-variant">
                  Run <span class="font-mono text-on-surface">{{ r.runId }}</span>
                  &middot; {{ (r.durationMs / 1000).toFixed(1) }}s
                  &middot; {{ r.files?.length || 0 }} archivos generados
                </p>
              </div>
            </div>
          </article>

          @if (excelFiles().length > 0) {
            <article class="card mb-6">
              <h3 class="section-title mb-4">Reportes por servicio ({{ excelFiles().length }})</h3>
              <ul class="space-y-2">
                @for (f of excelFiles(); track f.name) {
                  <li class="flex items-center justify-between rounded-lg border border-outline-variant/30 p-3">
                    <div class="flex items-center gap-3">
                      <span class="material-symbols-outlined text-secondary">table_view</span>
                      <div>
                        <p class="font-mono text-xs text-on-surface">{{ f.name }}</p>
                        <p class="text-[10px] text-on-surface-variant">{{ formatBytes(f.size) }}</p>
                      </div>
                    </div>
                    <a class="btn-secondary" [href]="fileUrl(r.runId, f.name)" download>
                      <span class="material-symbols-outlined text-sm">download</span>
                      Descargar
                    </a>
                  </li>
                }
              </ul>
            </article>
          }

          @if (r.stdoutTail) {
            <details class="mt-4">
              <summary class="cursor-pointer font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                Ver salida del proceso
              </summary>
              <pre class="mt-2 max-h-80 overflow-auto rounded bg-surface-container p-3 font-mono text-[10px] leading-relaxed text-on-surface-variant">{{ r.stdoutTail }}</pre>
            </details>
          }
        }
      }
    </section>
  `,
})
export class TasasPage {
  private readonly http = inject(HttpClient);

  readonly inputFile = signal<File | null>(null);
  readonly running = signal(false);
  readonly result = signal<RunResponse | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly errorDetail = signal<string | null>(null);

  readonly canRun = computed(() => !!this.inputFile() && !this.running());

  readonly excelFiles = computed(() =>
    (this.result()?.files ?? []).filter((f) => f.ext === '.xlsx' || f.ext === '.xls'),
  );

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.inputFile.set(input.files?.[0] ?? null);
    this.clearResults();
  }

  private clearResults(): void {
    this.result.set(null);
    this.errorMessage.set(null);
    this.errorDetail.set(null);
  }

  runTasas(): void {
    const file = this.inputFile();
    if (!file) return;

    this.running.set(true);
    this.clearResults();

    const form = new FormData();
    form.append('file', file, file.name);

    this.http.post<RunResponse>(longRunUrl('/api/tasas-ocupacion/run'), form).subscribe({
      next: (res) => {
        this.running.set(false);
        this.result.set(res);
        if (!res.success) {
          this.errorMessage.set(res.error || `Python terminó con código ${res.exitCode}.`);
          this.errorDetail.set(res.stderr || res.stdout || res.detail || null);
        }
      },
      error: (err) => {
        this.running.set(false);
        const body = err.error ?? {};
        this.errorMessage.set(body.error || err.message || 'Error desconocido en la ejecución.');
        this.errorDetail.set(body.stderr || body.stdout || body.detail || null);
        if (body.runId) {
          this.result.set(body);
        }
      },
    });
  }

  fileUrl(runId: string, name: string): string {
    return `/api/tasas-ocupacion/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(name)}`;
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
