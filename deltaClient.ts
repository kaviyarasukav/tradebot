import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

export class DeltaClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
  }

  private getAuthHeaders(method: string, path: string, queryParams: any, payload: any) {
    const apiKey = process.env.DELTA_KEY;
    const apiSecret = process.env.DELTA_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('Missing Delta API credentials (DELTA_KEY, DELTA_SECRET)');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const queryString = Object.keys(queryParams).length > 0 
      ? '?' + new URLSearchParams(queryParams).toString() 
      : '';
    const payloadStr = Object.keys(payload).length > 0 ? JSON.stringify(payload) : '';

    const signatureData = method.toUpperCase() + timestamp + path + queryString + payloadStr;
    const signature = crypto.createHmac('sha256', apiSecret).update(signatureData).digest('hex');

    return {
      'api-key': apiKey,
      'timestamp': timestamp,
      'signature': signature,
      'User-Agent': 'nodejs-bot',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  private async makeRequest(method: string, path: string, queryParams: any = {}, payload: any = {}, isPrivate: boolean = true) {
    const queryString = Object.keys(queryParams).length > 0 
      ? '?' + new URLSearchParams(queryParams).toString() 
      : '';
    
    let headers: any = {
      'User-Agent': 'nodejs-bot',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (isPrivate) {
      headers = this.getAuthHeaders(method, path, queryParams, payload);
    }

    const url = `${this.baseUrl}${path}${queryString}`;

    try {
      const response = await axios({
        method,
        url,
        data: Object.keys(payload).length > 0 ? payload : undefined,
        headers,
        timeout: 10000
      });
      return response.data;
    } catch (error: any) {
      if (error.response && error.response.data) {
         throw new Error(JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async getProducts() {
    return await this.makeRequest('GET', '/v2/products', {}, {}, false);
  }

  async getBalances() {
    return await this.makeRequest('GET', '/v2/wallet/balances');
  }

  async getPositions() {
    return await this.makeRequest('GET', '/v2/positions/margined');
  }

  async getProfile() {
    return await this.makeRequest('GET', '/v2/profile');
  }
  
  // NOTE: /v2/settings does not exist. Server time is obtained from the profile endpoint.

  async placeOrder(productId: number, size: number, side: 'buy' | 'sell', orderType: 'market_order' | 'limit_order' = 'market_order', extraParams: any = {}) {
    const payload = {
      product_id: productId,
      size: size,
      side: side.toLowerCase(),
      order_type: orderType,
      ...extraParams
    };
    return await this.makeRequest('POST', '/v2/orders', {}, payload);
  }

  /**
   * Places a bracket (TP/SL) order for an existing position.
   * Body must follow Delta's CreateBracketOrderRequest schema with
   * nested take_profit_order and/or stop_loss_order objects.
   * Endpoint: POST /v2/orders/bracket
   */
  async placeBracketOrder(payload: {
    product_id: number;
    product_symbol?: string;
    take_profit_order?: { order_type: string; stop_price: string; limit_price?: string };
    stop_loss_order?: { order_type: string; stop_price: string; limit_price?: string; trail_amount?: string };
  }) {
    return await this.makeRequest('POST', '/v2/orders/bracket', {}, payload);
  }
}

// Global instance to replace CCXT Delta
export const deltaClient = new DeltaClient();
