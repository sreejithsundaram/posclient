import { HttpInterceptorFn, HttpRequest, HttpHandlerFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from './auth/auth.service';

export const authInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn
) => {
  const auth    = inject(AuthService);
  const session = auth.session();

  if (!session?.accessToken) return next(req);

  const authReq = req.clone({
    setHeaders: { Authorization: `Bearer ${session.accessToken}` },
  });

  return next(authReq);
};
