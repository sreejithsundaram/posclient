import { Pipe, PipeTransform } from '@angular/core';
import { UomRecord } from './uom-editor.component';

@Pipe({ name: 'uomName', standalone: true })
export class UomNamePipe implements PipeTransform {
  transform(uoms: UomRecord[], id: number | null): string {
    if (id === null) return '—';
    return uoms.find(u => u.id === id)?.name ?? '—';
  }
}
