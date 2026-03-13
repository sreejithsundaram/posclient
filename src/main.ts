import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { ShellComponent } from './app/shell/shell.component';
 
bootstrapApplication(ShellComponent, {
  providers: [
    provideHttpClient(),
  ],
}).catch(err => console.error(err));
 
