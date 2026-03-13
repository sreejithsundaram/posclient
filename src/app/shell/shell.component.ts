import { Component, signal } from '@angular/core';
import { AppComponent } from '../app.component';
import { ProductEditorComponent } from '../products/editor/product-editor.component';
import { UomEditorComponent } from '../uom/editor/uom-editor.component';

export type AppRoute = 'terminal' | 'products' | 'uom';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [AppComponent, ProductEditorComponent, UomEditorComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  collapsed    = signal(false);
  activeRoute  = signal<AppRoute>('terminal');

  toggleSidebar() {
    this.collapsed.set(!this.collapsed());
  }

  navigate(route: AppRoute) {
    this.activeRoute.set(route);
  }
}
