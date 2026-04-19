import { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';


import { routes } from './app.routes';
import { authInterceptor } from './auth.interceptor';
import { apiInterceptor } from './api.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(
      withInterceptors([apiInterceptor, authInterceptor])
    ),
    provideRouter(routes)
  ]
};
