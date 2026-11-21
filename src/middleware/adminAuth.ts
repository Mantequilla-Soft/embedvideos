import { Request, Response, NextFunction } from 'express';
import { Config } from '../config/config';

/**
 * Middleware to protect admin endpoints with password
 */
export function createAdminAuthMiddleware(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const password = req.headers['x-admin-password'] as string ||
                     req.headers['authorization']?.replace('Bearer ', '');

    if (!password) {
      return res.status(401).json({ 
        error: 'Admin password required',
        message: 'Please provide admin password in X-Admin-Password or Authorization header' 
      });
    }
    
    if (password !== config.adminPassword) {
      // Never log either password: the expected one is the admin credential,
      // and a wrong guess is often a typo of it.
      console.warn(`Admin auth failed (wrong password) for ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ 
        error: 'Invalid admin password',
        message: 'The provided admin password is incorrect' 
      });
    }

    next();
  };
}
