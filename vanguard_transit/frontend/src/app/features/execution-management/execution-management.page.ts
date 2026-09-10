import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-execution-management',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-4 py-6 md:px-8 md:py-8">
      <header class="mb-6">
        <p class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">Ejecución operacional</p>
        <h1 class="mt-1 font-headline text-2xl font-bold uppercase tracking-tight text-on-surface md:text-3xl">Gestión</h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Comunicación operacional con conductores a través de WhatsApp. Use el comando <code class="rounded bg-surface-container px-1.5 py-0.5 text-[11px] text-primary">!puntualidad</code> para activar el chatbot.
        </p>
      </header>

      <article class="card-accent-primary">
        <div class="flex items-start gap-4">
          <span class="material-symbols-outlined text-3xl text-primary">sms</span>
          <div class="min-w-0 flex-1">
            <h2 class="section-title">Integración WhatsApp</h2>
            <p class="mt-2 text-sm leading-relaxed text-on-surface-variant">
              Abra WhatsApp Web y envíe el comando <strong>!puntualidad</strong> al chatbot para consultar los indicadores operacionales.
            </p>
            <div class="mt-4">
              <a
                href="https://wa.me/+56920094053?text=!puntualidad"
                target="_blank"
                rel="noopener noreferrer"
                class="btn-primary inline-flex gap-2"
              >
                <span class="material-symbols-outlined text-sm">open_in_new</span>
                Abrir WhatsApp
              </a>
            </div>
          </div>
        </div>
      </article>
    </section>
  `,
})
export class ExecutionManagementPage {}
