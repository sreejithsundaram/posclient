import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { ProductEditorComponent } from './app/products/editor/product-editor.component';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
