import BidSchema from './schemas/BidSchema';
import {AUCTION_STATE, REVIEW_STATE, ACCEPTED_STATE,
  REJECTED_STATE} from './Constants';
import os from 'os';
import fs from 'fs-extra';
import _ from 'lodash';

class Investor {
  constructor(dharma, decisionEngine) {
    this.dharma = dharma;
    this.decisionEngine = decisionEngine;
    this.portfolioStoreFile = os.homedir() + '/.dharma/portfolio.json';
  }

  static async fromPath(dharma, engineFilePath) {
    try {
      const decisionEngine = await import(engineFilePath);
      return new Investor(dharma, decisionEngine);
    } catch (err) {
      throw new Error("Decision engine file not found.");
    }
  }

  async startDaemon(errorCallback) {
    try {
      this.portfolio = await this.loadPortfolio();
    } catch (err) {
      this.portfolio = {};
    }

    this.createdEvent = await this.dharma.loans.events.created();
    this.createdEvent.watch(async function(err, result) {
      const loan = await this.dharma.loans.get(result.args.uuid);
      const bid = await this.decisionEngine.decide(loan);
      if (bid) {
        const schema = new BidSchema(this.dharma.web3);

        try {
          schema.validate(bid);
          await loan.bid(bid.amount, bid.bidder, bid.minInterestRate);
        } catch (err) {
          errorCallback(err);
          return;
        }

        this.portfolio[loan.uuid] = {
          loan: loan,
          bid: bid,
          state: AUCTION_STATE
        };

        this.refreshInvestment(loan.uuid);
      }
    }.bind(this));

    Object.keys(this.portfolio).forEach(async function (uuid) {
      this.refreshInvestment(uuid, this.portfolio[uuid].state);
    }.bind(this))
  }

  stopDaemon() {
    this.dharma.web3.reset();
  }

  async refreshInvestment(uuid) {
    const loan = this.portfolio[uuid].loan;
    const state = this.portfolio[uuid].state;

    switch (state) {
      case AUCTION_STATE:
        await this.setupAuctionStateListeners(loan);
        break;
      case REVIEW_STATE:
        await this.setupReviewStateListeners(loan);
        break;
      case ACCEPTED_STATE:
        await this.refreshAcceptedState(loan);
        break;
      case REJECTED_STATE:
        await this.refreshRejectedState(loan);
        break;
    }
  }

  async setupAuctionStateListeners(loan) {
    const auctionCompletedEvent = await loan.events.auctionCompleted();
    auctionCompletedEvent.watch(() => { this.setupReviewStateListeners(loan) })

    this.setupReviewStateListeners(loan);
  }

  async setupReviewStateListeners(loan) {
    const termBeginEvent = await loan.events.termBegin();
    const bidsRejectedEvent = await loan.events.bidsRejected();
    const bidsIgnoredEvent = await loan.events.reviewPeriodCompleted();

    termBeginEvent.watch(this.termBeginCallback(loan.uuid, termBeginEvent))
    bidsRejectedEvent.watch(this.bidsRejectedCallback(loan.uuid, bidsRejectedEvent))
    bidsIgnoredEvent.watch(this.bidsIgnoredCallback(loan.uuid, bidsIgnoredEvent))
  }

  async refreshAcceptedState(loan) {
    if (!this.portfolio[loan.uuid].refundWithdrawn) {
      const investment = this.portfolio[loan.uuid];
      const bid = investment.bid;
      const loan = investment.loan;
      const tokenBalance = await loan.balanceOf(bid.bidder);
      if (tokenBalance.lt(bid.amount)) {
        await loan.withdrawInvestment({ from: bid.bidder })

        this.portfolio[loan.uuid].refundWithdrawn = true;
        await this.savePortfolio()
      }
    }
  }

  async refreshRejectedState(loan) {
    if (!this.portfolio[loan.uuid].refundWithdrawn) {
      const investment = this.portfolio[loan.uuid];
      const bid = investment.bid;

      await loan.withdrawInvestment({ from: bid.bidder })

      this.portfolio[loan.uuid].refundWithdrawn = true;
      await this.savePortfolio()
    }
  }

  auctionCompletedCallback(uuid, auctionCompletedEvent) {
    const _this = this;

    return async (err) => {
      auctionCompletedEvent.stopWatching(async () => {
        _this.portfolio[uuid].state = REVIEW_STATE;
        await _this.savePortfolio()
      })
    };
  }

  termBeginCallback(uuid, termBeginEvent) {
    const _this = this;

    return async (err, result) => {
      termBeginEvent.stopWatching(async () => {
        let investment = _this.portfolio[uuid];
        const bid = investment.bid;
        const loan = investment.loan;
        const tokenBalance = await loan.balanceOf(bid.bidder);
        _this.portfolio[uuid].balance = tokenBalance;

        if (tokenBalance.lt(bid.amount)) {
          await loan.withdrawInvestment({ from: bid.bidder })
          _this.portfolio[uuid].refundWithdrawn = true;
        }

        _this.portfolio[uuid].state = ACCEPTED_STATE;
        await _this.savePortfolio();
      })
    };
  }

  bidsRejectedCallback(uuid, bidsRejectedEvent) {
    const _this = this;

    return (err) => {
      bidsRejectedEvent.stopWatching(async () => {
        const investment = _this.portfolio[uuid];
        const bid = investment.bid;
        const loan = investment.loan;

        await loan.withdrawInvestment({ from: bid.bidder })

        _this.portfolio[loan.uuid].refundWithdrawn = true;
        _this.portfolio[uuid].state = REJECTED_STATE;
        await _this.savePortfolio();
      })
    };
  }

  bidsIgnoredCallback(uuid, bidsIgnoredEvent) {
    const _this = this;

    return (err) => {
      bidsIgnoredEvent.stopWatching(async () => {
        const investment = _this.portfolio[uuid];
        const bid = investment.bid;
        const loan = investment.loan;
        await loan.withdrawInvestment({ from: bid.bidder })

        _this.portfolio[loan.uuid].refundWithdrawn = true;
        _this.portfolio[uuid].state = REJECTED_STATE;
        await _this.savePortfolio();
      })
    };
  }

  async loadPortfolio() {
    let portfolio;
    try {
      portfolio = await fs.readJson(this.portfolioStoreFile);
    } catch (err) {
      throw new Error('Portfolio store file does not exist.');
    }

    const promises = Object.keys(portfolio).map(function (uuid) {
      return new Promise(async function (resolve, reject) {
        portfolio[uuid].loan = await this.dharma.loans.get(uuid);
        portfolio[uuid].state = await portfolio[uuid].loan.getState();
        resolve();
      }.bind(this))
    }.bind(this))

    await Promise.all(promises);

    return portfolio;
  }

  async savePortfolio() {
    let portfolio = {};

    Object.keys(this.portfolio).forEach(function (uuid) {
      let investment = _.omit(this.portfolio[uuid], 'loan');
      portfolio[uuid] = _.cloneDeep(investment);
    }.bind(this))

    await fs.outputJson(this.portfolioStoreFile, portfolio);
  }

  async collect(uuid) {
    const portfolio = await this.loadPortfolio()

    const investment = portfolio[uuid];
    await investment.loan.redeemValue(investment.bid.bidder, { from: investment.bid.bidder });
  }
}

module.exports = Investor;