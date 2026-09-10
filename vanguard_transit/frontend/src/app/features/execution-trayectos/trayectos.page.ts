import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

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
  readonly expedicionesFile?: string;
  readonly busesFile?: string;
  readonly dia?: string | null;
  readonly files?: OutputFile[];
  readonly stdoutTail?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly detail?: string;
}

@Component({
  selector: 'app-execution-trayectos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-4 py-6 md:px-8 md:py-8">
      <header class="mb-6">
        <p class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">Ejecución operacional</p>
        <h1 class="mt-1 font-headline text-2xl font-bold uppercase tracking-tight text-on-surface md:text-3xl">Trayectos realizados</h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Visualice geográficamente los recorridos de cada bus. Cargue los archivos de expediciones y mapeo de buses;
          de forma opcional, filtre por un día específico para acelerar el procesamiento.
        </p>
      </header>

      <!-- Carga de archivos -->
      <article class="card-accent-secondary mb-6">
        <div class="flex flex-col gap-6">

          <!-- Expediciones -->
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div class="flex items-center gap-4">
              <span class="material-symbols-outlined text-3xl text-secondary">upload_file</span>
              <div>
                <h3 class="section-title">Archivo de expediciones (TXT)</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Datos GPS de cada punto de control de las expediciones.</p>
                @if (expedicionesFile()) {
                  <p class="mt-1 font-mono text-xs text-on-surface">
                    {{ expedicionesFile()!.name }}
                    <span class="text-on-surface-variant">({{ formatBytes(expedicionesFile()!.size) }})</span>
                  </p>
                }
              </div>
            </div>
            <div>
              <input #expInput class="hidden" type="file" accept=".txt" (change)="onExpedicionesSelected($event)">
              <button class="btn-secondary" type="button" [disabled]="running()" (click)="expInput.click()">
                <span class="material-symbols-outlined text-sm">folder_open</span>
                {{ expedicionesFile() ? 'Cambiar' : 'Elegir archivo' }}
              </button>
            </div>
          </div>

          <div class="border-t border-outline-variant/30"></div>

          <!-- Buses -->
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div class="flex items-center gap-4">
              <span class="material-symbols-outlined text-3xl text-secondary">map</span>
              <div>
                <h3 class="section-title">Archivo de buses (XLSX)</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Mapeo PPU → Número de bus.</p>
                @if (busesFile()) {
                  <p class="mt-1 font-mono text-xs text-on-surface">
                    {{ busesFile()!.name }}
                    <span class="text-on-surface-variant">({{ formatBytes(busesFile()!.size) }})</span>
                  </p>
                }
              </div>
            </div>
            <div>
              <input #busInput class="hidden" type="file" accept=".xlsx,.xls" (change)="onBusesSelected($event)">
              <button class="btn-secondary" type="button" [disabled]="running()" (click)="busInput.click()">
                <span class="material-symbols-outlined text-sm">folder_open</span>
                {{ busesFile() ? 'Cambiar' : 'Elegir archivo' }}
              </button>
            </div>
          </div>

          <div class="border-t border-outline-variant/30"></div>

          <!-- Filtro de fecha (opcional) -->
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div class="flex items-center gap-4">
              <span class="material-symbols-outlined text-3xl text-secondary">calendar_month</span>
              <div>
                <h3 class="section-title">Filtro por día (opcional)</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Filtre por un único día para reducir el tiempo de procesamiento.</p>
                <p class="mt-2 text-xs text-on-surface-variant">Formato: YYYY-MM-DD</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <input
                type="text"
                [(ngModel)]="diaFiltro"
                placeholder="Ej: 2026-05-15"
                class="rounded-lg border border-outline-variant/30 bg-surface px-3 py-2 font-mono text-sm text-on-surface placeholder-on-surface-variant/50 outline-none"
                [disabled]="running()"
              >
            </div>
          </div>

          <!-- Botón ejecutar -->
          <div class="border-t border-outline-variant/30 pt-2 flex justify-end">
            <button class="btn-primary" type="button" [disabled]="!canRun()" (click)="runTrayectos()">
              @if (running()) {
                <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Generando gráficos...
              } @else {
                <span class="material-symbols-outlined text-sm">play_arrow</span>
                Procesar
              }
            </button>
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
                  &middot; {{ r.files?.length || 0 }} gráficos generados
                  @if (r.dia) {
                    &middot; día <span class="font-mono text-on-surface">{{ r.dia }}</span>
                  }
                </p>
              </div>
            </div>
          </article>

          @if (imageFiles().length > 0) {
            <article class="card">
              <h3 class="section-title mb-4">Gráficos por bus ({{ groupedImages().length }} buses)</h3>

              @for (busGroup of groupedImages(); track busGroup.bus) {
                <div class="mb-8 last:mb-0">
                  <h4 class="mb-3 rounded-lg bg-surface-container px-3 py-2 font-label text-[10px] font-bold uppercase tracking-widest text-primary">
                    Bus {{ busGroup.bus }} <span class="ml-2 text-on-surface-variant">({{ busGroup.images.length }} gráficos)</span>
                  </h4>
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    @for (f of busGroup.images; track f.name) {
                      <figure class="overflow-hidden rounded-lg border border-outline-variant/30 bg-surface">
                        <a [href]="fileUrl(r.runId, f.name)" target="_blank" rel="noopener">
                          <img class="block w-full object-contain bg-white" [src]="fileUrl(r.runId, f.name)" [alt]="f.name" loading="lazy">
                        </a>
                        <figcaption class="flex items-center justify-between gap-2 border-t border-outline-variant/30 px-3 py-2">
                          <span class="truncate font-mono text-[10px] text-on-surface-variant" [title]="f.name">{{ f.name }}</span>
                          <a class="text-primary hover:text-primary-dim" [href]="fileUrl(r.runId, f.name)" download [title]="'Descargar ' + f.name">
                            <span class="material-symbols-outlined text-sm">download</span>
                          </a>
                        </figcaption>
                      </figure>
                    }
                  </div>
                </div>
              }
            </article>
          }

          @if (r.stdoutTail) {
            <details class="mt-6">
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
export class TrayectosPage {
  private readonly http = inject(HttpClient);

  readonly expedicionesFile = signal<File | null>(null);
  readonly busesFile = signal<File | null>(null);
  readonly running = signal(false);
  readonly result = signal<RunResponse | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly errorDetail = signal<string | null>(null);
  readonly diaFiltro = signal('');

  readonly canRun = computed(() => !!this.expedicionesFile() && !!this.busesFile() && !this.running());

  readonly imageFiles = computed(() =>
    (this.result()?.files ?? []).filter((f) => ['.jpg', '.jpeg', '.png', '.svg'].includes(f.ext)),
  );

  readonly groupedImages = computed(() => {
    const images = this.imageFiles();
    const groups = new Map<string, OutputFile[]>();

    for (const img of images) {
      const parts = img.name.split('/');
      const bus = parts.length > 0 ? parts[0] : 'unknown';

      if (!groups.has(bus)) {
        groups.set(bus, []);
      }
      groups.get(bus)!.push(img);
    }

    return Array.from(groups.entries())
      .map(([bus, imgs]) => ({
        bus,
        images: imgs.sort((a, b) => {
          const numA = parseInt(a.name.match(/\d+/)?.[0] || '0', 10);
          const numB = parseInt(b.name.match(/\d+/)?.[0] || '0', 10);
          return numA - numB;
        }),
      }))
      .sort((a, b) => {
        const numA = parseInt(a.bus, 10);
        const numB = parseInt(b.bus, 10);
        return numA - numB;
      });
  });

  onExpedicionesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.expedicionesFile.set(input.files?.[0] ?? null);
    this.clearResults();
  }

  onBusesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.busesFile.set(input.files?.[0] ?? null);
    this.clearResults();
  }

  private clearResults(): void {
    this.result.set(null);
    this.errorMessage.set(null);
    this.errorDetail.set(null);
  }

  runTrayectos(): void {
    const exp = this.expedicionesFile();
    const buses = this.busesFile();
    if (!exp || !buses) return;

    this.running.set(true);
    this.clearResults();

    const form = new FormData();
    form.append('expediciones', exp, exp.name);
    form.append('buses', buses, buses.name);
    if (this.diaFiltro()) {
      form.append('dia', this.diaFiltro());
    }

    this.http.post<RunResponse>(longRunUrl('/api/trayectos/run'), form).subscribe({
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
    return `/api/trayectos/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(name)}`;
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
